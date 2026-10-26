"""Request-backed FC execution: only watched executions may allocate a sandbox."""
import threading
from sqlalchemy import select, update
from .db import attempts, executions
from .service import ACTIVE
from .worker import Worker


class InternalRuntime:
    def __init__(self, service):
        self.service=service
        self.lock=threading.RLock()
        self.refs={}
        self.stop=threading.Event()
        service.runtime=self

    def watching(self,eid):
        with self.lock:
            return self.refs.get(eid,0)>0

    def acquire(self,eid):
        with self.lock:
            self.refs[eid]=self.refs.get(eid,0)+1

    def release(self,eid):
        with self.lock:
            self.refs[eid]=max(0,self.refs.get(eid,0)-1)
            remaining=self.refs[eid]
            if not remaining:
                self.refs.pop(eid, None)
        if not remaining:
            self.pause(eid,'CLIENT_DISCONNECTED')

    def pause(self,eid,reason):
        with self.service.db.tx() as conn:
            ids=list(conn.execute(select(attempts.c.id).where((attempts.c.execution_id==eid)&attempts.c.state.in_(ACTIVE))).scalars())
        worker=Worker(self.service)
        for aid in ids:
            worker.fail(aid,reason)
            worker.cleanup(aid)

    def start(self):
        # No process survives a new control process. Fence previous attempts before serving.
        with self.service.db.tx() as conn:
            old=list(conn.execute(select(attempts.c.execution_id).where(attempts.c.state.in_(ACTIVE))).scalars())
            conn.execute(update(attempts).where(attempts.c.cleaned==0).values(poll_until=0))
        for eid in old:
            self.pause(eid,'INSTANCE_RESTARTED')
        from .teaching_worker import run
        self.thread=threading.Thread(target=run,args=(self.service,self.stop),daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        for eid in list(self.refs):
            self.pause(eid,'CLIENT_DISCONNECTED')
        self.thread.join(timeout=5)
