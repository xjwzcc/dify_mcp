"""Durable state commits and buffered progress snapshots through the OSS broker."""
from contextlib import contextmanager
from pathlib import Path
import os
import sqlite3
import tempfile
import threading
import urllib.request
import logging
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine
from .db import Database, meta


class Persistence:
    def request(self, method, route, data=None):
        request = urllib.request.Request('http://127.0.0.1:' + os.environ.get('AGENT_PERSISTENCE_PORT', '9182') + route,
            data=data, method=method, headers={'Authorization': 'Bearer ' + os.environ['AGENT_PERSISTENCE_KEY']})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=45) as response:
            return response.read(48 * 1024 * 1024)


class FcDatabase(Database):
    """One writer. Authoritative transitions wait for immutable OSS commit.

    Draft events and short-lived leases may be replayed from local SQLite before
    their next batch snapshot. A restart fences the unfinished attempt. Final
    answers, admission, cancellation and tool effects still commit synchronously.
    """
    def __init__(self, settings, persistence=None):
        self.persistence = persistence or Persistence()
        self.lock = threading.RLock()
        self.upload_lock = threading.Lock()
        self.changed = threading.Condition()
        self.revision = 0
        self.persisted_revision = -1
        self.stop = threading.Event()
        self.writer = None
        self.poisoned = False
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = settings.data_dir / 'agent.sqlite'
        recovered = self.persistence.request('GET', '/database')
        if recovered:
            self.path.write_bytes(recovered)
        else:
            self.path.unlink(missing_ok=True)
        self.engine = create_engine('sqlite:///' + str(self.path), poolclass=StaticPool,
            connect_args={'check_same_thread': False, 'timeout': 30})

    def snapshot(self):
        # Copy under the SQL lock, but never hold it during a buffered OSS upload.
        with self.lock:
            if self.poisoned:
                raise RuntimeError('AGENT_DURABILITY_UNKNOWN_RESTART_REQUIRED')
            if self.revision <= self.persisted_revision:
                return None
            with tempfile.TemporaryDirectory(dir=self.path.parent) as directory:
                snapshot = Path(directory) / 'snapshot.sqlite'
                with sqlite3.connect(self.path) as source, sqlite3.connect(snapshot) as target:
                    source.backup(target)
                return self.revision, snapshot.read_bytes()

    def persist(self, snapshot=None):
        try:
            snapshot = snapshot or self.snapshot()
            if snapshot is None:
                return
            revision, data = snapshot
            with self.upload_lock:
                if self.poisoned:
                    raise RuntimeError('Recovery required')
                # An older background snapshot can arrive after a final commit.
                if revision <= self.persisted_revision:
                    return
                self.persistence.request('PUT', '/database', data)
                self.persisted_revision = revision
        except BaseException:
            self.poisoned = True
            raise RuntimeError('AGENT_DURABILITY_UNKNOWN_RESTART_REQUIRED') from None

    def start_writer(self):
        def write_batches():
            while not self.stop.wait(1):
                try:
                    self.persist()
                except Exception:
                    logging.getLogger(__name__).error('Progress persistence failed; recovery required')
                    return
        self.writer = threading.Thread(target=write_batches, daemon=True)
        self.writer.start()

    def close_writer(self):
        self.stop.set()
        if self.writer:
            self.writer.join(timeout=5)
        if not self.poisoned:
            self.persist()

    def wait_for_change(self, revision, timeout=1):
        with self.changed:
            self.changed.wait_for(lambda: self.revision != revision or self.poisoned, timeout)

    def initialize(self):
        with self.lock:
            meta.create_all(self.engine)
            self.revision += 1
            self.persist()

    @contextmanager
    def tx(self, *, durable=True):
        with self.lock:
            if self.poisoned:
                raise RuntimeError('AGENT_DURABILITY_UNKNOWN_RESTART_REQUIRED')
            with self.engine.connect() as conn:
                conn.exec_driver_sql('BEGIN IMMEDIATE')
                before = conn.connection.driver_connection.total_changes
                try:
                    yield conn
                    changed = conn.connection.driver_connection.total_changes != before
                    conn.commit()
                    if changed:
                        self.revision += 1
                        if durable:
                            self.persist()
                        with self.changed:
                            self.changed.notify_all()
                except BaseException:
                    conn.rollback()
                    raise
