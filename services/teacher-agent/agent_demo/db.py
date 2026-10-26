from contextlib import contextmanager
import json
import time
import uuid

from sqlalchemy import (create_engine, MetaData, Table, Column, String, Integer, Float,
                        Text, JSON, select, insert, update, UniqueConstraint)

meta = MetaData()
sessions = Table("chat_session", meta,
    Column("id", String(32), primary_key=True), Column("tenant", String(128), nullable=False),
    Column("revision", Integer, nullable=False), Column("checkpoint", JSON, nullable=False),
    Column("active_execution", String(32)), Column("created", Float, nullable=False))
executions = Table("chat_execution", meta,
    Column("id", String(32), primary_key=True), Column("session_id", String(32), nullable=False),
    Column("tenant", String(128), nullable=False), Column("request_id", String(128), nullable=False),
    Column("input_hash", String(64), nullable=False), Column("prompt", Text, nullable=False),
    Column("attachments", JSON, nullable=False), Column("skills", JSON, nullable=False),
    Column("profile", String(128), nullable=False), Column("capabilities", JSON, nullable=False),
    Column("state", String(32), nullable=False),
    Column("attempt_no", Integer, nullable=False), Column("available", Float, nullable=False),
    Column("result", Text), Column("error", String(128)), Column("created", Float, nullable=False),
    UniqueConstraint("session_id", "request_id"))
attempts = Table("chat_attempt", meta,
    Column("id", String(32), primary_key=True), Column("execution_id", String(32), nullable=False),
    Column("number", Integer, nullable=False), Column("owner", String(32), nullable=False),
    Column("token_hash", String(64), nullable=False), Column("state", String(32), nullable=False),
    Column("lease_until", Float, nullable=False), Column("deadline", Float, nullable=False),
    Column("poll_until", Float, nullable=False),
    Column("basis_revision", Integer, nullable=False), Column("config_digest", String(64), nullable=False),
    Column("sandbox_id", String(128)), Column("cleaned", Integer, nullable=False),
    Column("request_count", Integer, nullable=False), Column("event_bytes", Integer, nullable=False),
    Column("created", Float, nullable=False), UniqueConstraint("execution_id", "number"))
events = Table("chat_event", meta,
    Column("execution_id", String(32), primary_key=True),
    Column("seq", Integer, primary_key=True), Column("attempt_id", String(32)),
    Column("source_id", String(200), nullable=False), Column("type", String(64), nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("execution_id", "source_id"))
artifacts = Table("chat_artifact", meta,
    Column("id", String(32), primary_key=True), Column("tenant", String(128), nullable=False),
    Column("session_id", String(32), nullable=False), Column("name", String(240), nullable=False),
    Column("ref", JSON, nullable=False), Column("created", Float, nullable=False))
operations = Table("tool_operation", meta,
    Column("id", String(32), primary_key=True), Column("execution_id", String(32), nullable=False),
    Column("attempt_id", String(32), nullable=False), Column("tool", String(128), nullable=False),
    Column("args_hash", String(64), nullable=False), Column("args", JSON, nullable=False),
    Column("state", String(32), nullable=False), Column("result", JSON),
    UniqueConstraint("execution_id", "tool", "args_hash"))


def uid():
    return uuid.uuid4().hex


def row(conn, table, condition):
    value = conn.execute(select(table).where(condition)).mappings().first()
    return dict(value) if value else None


class Database:
    def __init__(self, settings):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        options = {"connect_args": {"check_same_thread": False, "timeout": 30}} if settings.database_url.startswith("sqlite") else {}
        if not settings.database_url.startswith("sqlite"):
            options["isolation_level"] = "READ COMMITTED"
        self.engine = create_engine(settings.database_url, pool_pre_ping=True, **options)

    def initialize(self):
        meta.create_all(self.engine)

    @contextmanager
    def tx(self, *, durable=True):
        with self.engine.connect() as conn:
            if self.engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            else:
                conn.begin()
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    def lock_session(self, conn, session_id):
        result = conn.execute(select(sessions).where(sessions.c.id == session_id).with_for_update()).mappings().first()
        if not result:
            raise KeyError("Session not found")
        return dict(result)

    def event(self, conn, execution_id, kind, payload, attempt_id=None, source_id=None):
        # All callers hold this execution's session lock, including gateway event writers.
        source_id = source_id or uid()
        found = row(conn, events, (events.c.execution_id == execution_id) & (events.c.source_id == source_id))
        if found:
            return found["seq"]
        seq = conn.execute(select(events.c.seq).where(events.c.execution_id == execution_id)
                           .order_by(events.c.seq.desc()).limit(1)).scalar()
        seq = (seq or 0) + 1
        conn.execute(insert(events).values(execution_id=execution_id, seq=seq,
            attempt_id=attempt_id, source_id=source_id, type=kind, payload=payload))
        return seq
