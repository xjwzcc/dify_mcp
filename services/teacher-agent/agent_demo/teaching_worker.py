"""Resident supervisor; authorization renewal never waits for sandbox allocation.

Run as a separate continuously scheduled process, not an FC post-response task.
All ownership, fences and capacity are in SQL; process restarts lose no queue.
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select

from .db import attempts
from .service import ACTIVE
from .worker import Worker

LOG = logging.getLogger(__name__)


def run(service, stop=None):
    stop = stop or threading.Event()

    def loop(action, delay):
        while not stop.is_set():
            try:
                action()
            except Exception as exc:
                LOG.error("Teaching lifecycle step failed: %s", type(exc).__name__)
            stop.wait(delay)

    def authorize():
        with service.db.tx() as conn:
            active = list(conn.execute(select(attempts.c.id, attempts.c.execution_id).where(attempts.c.state.in_(ACTIVE))).mappings())

        def renew(a):
            try:
                service.refresh_authorization(a["execution_id"])
            except Exception as exc:
                Worker(service).fail(a["id"], Worker.error_code(exc))
        # One bounded request per active attempt; no SQL lock spans network IO.
        with ThreadPoolExecutor(max_workers=service.s.max_active) as pool:
            list(pool.map(renew, active))

    def reconcile():
        with service.db.tx() as conn:
            ids = list(conn.execute(select(attempts.c.id).where(attempts.c.cleaned == 0)).scalars())

        def step(aid):
            worker = Worker(service)
            worker.reconcile(aid)
            worker.cleanup(aid)
        with ThreadPoolExecutor(max_workers=service.s.max_active) as pool:
            list(pool.map(step, ids))

    allocation_pool = ThreadPoolExecutor(max_workers=service.s.max_active)
    allocating = set()

    def dispatch():
        for future in list(allocating):
            if future.done():
                allocating.remove(future)
                future.result()
        while len(allocating) < service.s.max_active:
            worker = Worker(service)
            claimed = worker.claim()
            if not claimed:
                break
            allocating.add(allocation_pool.submit(worker.start, *claimed))

    threads = [threading.Thread(target=loop, args=(action, delay), daemon=True)
               for action, delay in [(authorize, 0.5), (reconcile, 1), (dispatch, 0.5)]]
    for thread in threads:
        thread.start()
    try:
        while not stop.wait(1):
            if any(not thread.is_alive() for thread in threads):
                raise RuntimeError("Teaching supervisor thread stopped")
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=5)
        allocation_pool.shutdown(wait=True)
