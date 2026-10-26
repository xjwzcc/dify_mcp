"""Teaching identity, read-only tools and durable admission control.

Only the BFF may supply identity. Model arguments never determine a teacher,
course, session credential or service endpoint.
"""
import base64
import hashlib
import hmac
import json
import re
import time

import httpx
from sqlalchemy import Table, Column, String, Float, JSON, UniqueConstraint, select, insert, update, func
from starlette.responses import JSONResponse

from .capabilities import canonical, digest
from .db import meta, sessions, executions, attempts, events, row, uid
from .service import Service, ACTIVE, TERMINAL
from .storage import InputError

VERSION = "teaching-read-v1"
scope_table = Table("teacher_execution_scope", meta,
    Column("execution_id", String(32), primary_key=True),
    Column("identity", JSON, nullable=False), Column("page_context", JSON, nullable=False),
    Column("valid_until", Float, nullable=False))
session_info = Table("teacher_session_info", meta,
    Column("session_id", String(32), primary_key=True), Column("tenant", String(128), nullable=False),
    Column("request_id", String(128), nullable=False), Column("title", String(100), nullable=False),
    UniqueConstraint("tenant", "request_id"))
capacity = Table("teacher_capacity_lock", meta, Column("id", String(32), primary_key=True))
# A new table keeps existing deployments upgradeable without ALTERing historical rows.
session_lifecycle = Table("teacher_session_lifecycle", meta,
    Column("session_id", String(32), primary_key=True), Column("tenant", String(128), nullable=False),
    Column("opened", Float, nullable=False), Column("closed", Float),
    Column("sandbox_expires", Float, nullable=False, default=0))


def encode(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def decode(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def sign(claims, key):
    payload = encode(canonical(claims).encode())
    return payload + "." + encode(hmac.digest(key.encode(), payload.encode(), "sha256"))


def verify(value, key, method, path, body, deployment):
    try:
        if len(key) < 32 or len(value) > 8192 or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", value):
            raise ValueError()
        payload, signature = value.split(".")
        if not hmac.compare_digest(signature, encode(hmac.digest(key.encode(), payload.encode(), "sha256"))):
            raise ValueError()
        c = json.loads(decode(payload))
        now = time.time()
        if (c["v"] != 1 or c["iss"] != "teaching-platform" or c["aud"] != "teacher-agent"
            or c["deployment_id"] != deployment or c["method"] != method or c["path"] != path
            or c["body_sha256"] != hashlib.sha256(body).hexdigest()
            or not now < c["exp"] <= c["iat"] + 60 or c["iat"] > now + 5 or c["exp"] <= c["iat"]
            or c["role"] != "teacher" or c["course"] not in {"hotel", "catering"}
            or not isinstance(c["sub"], str) or not 1 <= len(c["sub"]) <= 80
            or not re.fullmatch(r"[a-f0-9]{64}", c["login_ref"]) or c["login_expires_at"] <= now):
            raise ValueError()
        tenant = hashlib.sha256((deployment + "\0" + c["course"] + "\0" + c["sub"]).encode()).hexdigest()
        return {"tenant": tenant, "profiles": [c["course"] + "-teacher"],
                "identity": {"course": c["course"], "teacher_id": c["sub"],
                             "login_ref": c["login_ref"], "login_expires_at": c["login_expires_at"]}}
    except (ValueError, TypeError, KeyError, AttributeError):
        raise PermissionError("INVALID_TEACHER_ASSERTION") from None


class TeachingAuthentication:
    def __init__(self, app, settings):
        self.app, self.s = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/chat/"):
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if not message.get("more_body"):
                break
        try:
            headers = dict(scope["headers"])
            path = scope.get("raw_path", scope["path"].encode()).decode("ascii")
            if scope.get("query_string"):
                path += "?" + scope["query_string"].decode("ascii")
            principal = verify(headers.get(b"x-teacher-assertion", b"").decode(), self.s.teaching_verify_key,
                               scope["method"], path, bytes(body), self.s.teaching_deployment)
        except (PermissionError, UnicodeError):
            return await JSONResponse({"error": {"code": "INVALID_TEACHER_ASSERTION", "message": "教师身份校验失败"}}, 403)(scope, receive, send)
        scope.setdefault("state", {})["teacher_principal"] = principal
        pending = True

        async def replay():
            nonlocal pending
            if pending:
                pending = False
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


class TeachingService(Service):
    def lock_capacity(self, conn):
        if not conn.execute(select(capacity).where(capacity.c.id == "global").with_for_update()).first():
            raise InputError("TEACHING_DATABASE_NOT_INITIALIZED")

    def create_teacher_session(self, principal, request_id, title="新对话"):
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
            raise InputError("INVALID_REQUEST_ID")
        if not isinstance(title, str) or len(title) > 100:
            raise InputError("INVALID_TITLE")
        tenant = principal["tenant"]
        with self.db.tx() as conn:
            self.lock_capacity(conn)
            old = row(conn, session_info, (session_info.c.tenant == tenant) & (session_info.c.request_id == request_id))
            if old:
                return {"session_id": old["session_id"]}
            self.admit_session(conn, tenant)
            sid = uid()
            conn.execute(insert(sessions).values(id=sid, tenant=tenant, revision=0, checkpoint={}, created=time.time()))
            conn.execute(insert(session_info).values(session_id=sid, tenant=tenant, request_id=request_id, title=title or "新对话"))
            conn.execute(insert(session_lifecycle).values(session_id=sid, tenant=tenant, opened=time.time(), sandbox_expires=0))
            return {"session_id": sid}

    def admit_session(self, conn, tenant):
        count = conn.execute(select(func.count()).select_from(session_lifecycle).where(
            (session_lifecycle.c.tenant == tenant) & session_lifecycle.c.closed.is_(None))).scalar()
        if count >= self.s.max_teacher_sessions:
            raise InputError('TEACHER_SESSION_LIMIT')

    def require_open_session(self, conn, tenant, sid):
        self.session(conn, tenant, sid)
        lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == sid)
        if lifecycle and lifecycle['closed'] is not None:
            raise InputError('SESSION_CLOSED')
        if not lifecycle:
            # Historical conversations are archived until explicitly used again.
            self.admit_session(conn, tenant)
            conn.execute(insert(session_lifecycle).values(session_id=sid, tenant=tenant, opened=time.time(), sandbox_expires=0))

    def reserve_sandbox(self, conn, ex):
        if self.s.provider != 'fc-internal':
            return None
        self.require_open_session(conn, ex['tenant'], ex['session_id'])
        lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == ex['session_id'])
        expires = lifecycle['sandbox_expires']
        if expires <= time.time():
            expires = time.time() + self.s.sandbox_lifetime_seconds
            conn.execute(update(session_lifecycle).where(session_lifecycle.c.session_id == ex['session_id']).values(sandbox_expires=expires))
        return expires

    def close_session(self, tenant, sid):
        with self.db.tx() as conn:
            self.lock_capacity(conn)
            self.session(conn, tenant, sid)
            lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == sid)
            if not lifecycle:
                conn.execute(insert(session_lifecycle).values(session_id=sid, tenant=tenant, opened=time.time(), closed=time.time(), sandbox_expires=0))
            else:
                conn.execute(update(session_lifecycle).where(session_lifecycle.c.session_id == sid).values(closed=lifecycle['closed'] or time.time(), sandbox_expires=0))
            pending = list(conn.execute(select(executions.c.id).where(
                (executions.c.session_id == sid) & ~executions.c.state.in_(TERMINAL))).scalars())
            for eid in pending:
                conn.execute(update(executions).where(executions.c.id == eid).values(state='CANCELLED', error='SESSION_CLOSED'))
                conn.execute(update(attempts).where((attempts.c.execution_id == eid) & attempts.c.state.in_(ACTIVE)).values(state='CANCELLED'))
                self.db.event(conn, eid, 'turn.cancelled', {'reason':'SESSION_CLOSED'})
        # Fence durable state first, then synchronously reclaim this session's sandbox.
        if self.s.provider == 'fc-internal':
            from .providers import provider
            provider(self.s).end_session(sid)
        return {'ok':True, 'closed':True}

    def input_fingerprint(self, principal, values):
        return digest([*values, principal.get("page_context", {}), VERSION])

    def before_submit(self, conn, principal, sid):
        self.require_open_session(conn, principal['tenant'], sid)
        count = conn.execute(select(func.count()).select_from(executions).where(
            (executions.c.tenant == principal["tenant"]) & executions.c.state.in_(["QUEUED", "RETRY_WAIT"]))).scalar()
        if count >= self.s.max_teacher_pending:
            raise InputError("TEACHER_QUEUE_FULL")

    def after_submit(self, conn, principal, eid, sid):
        conn.execute(insert(scope_table).values(execution_id=eid, identity=principal["identity"],
            page_context=principal.get("page_context", {}), valid_until=0))
        title = row(conn, session_info, session_info.c.session_id == sid)
        if title and title["title"] == "新对话":
            ex = row(conn, executions, executions.c.id == eid)
            conn.execute(update(session_info).where(session_info.c.session_id == sid).values(title=ex["prompt"][:60]))

    def may_claim(self, conn, ex):
        if self.s.provider == 'fc-internal' and not self.runtime.watching(ex['id']):
            return False
        lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == ex['session_id'])
        if lifecycle and lifecycle['closed'] is not None:
            return False
        if self.s.provider == 'fc-internal':
            from .providers import provider
            if not provider(self.s).has_capacity(ex['session_id']):
                return False
            # Count actual retained namespaces plus allocations not yet cleaned.
            # A persisted expiry alone must not hold capacity after FC restarts.
            reserved = provider(self.s).retained_sessions() | set(conn.execute(
                select(executions.c.session_id).join(attempts, attempts.c.execution_id == executions.c.id)
                .where(attempts.c.cleaned == 0)).scalars())
            if ex['session_id'] not in reserved and len(reserved) >= self.s.max_sandboxes:
                return False
        occupied = select(attempts).join(executions, attempts.c.execution_id == executions.c.id).where(attempts.c.cleaned == 0)
        total = conn.execute(select(func.count()).select_from(occupied.subquery())).scalar()
        owned = conn.execute(select(func.count()).select_from(
            occupied.where(executions.c.tenant == ex["tenant"]).subquery())).scalar()
        return total < self.s.max_active and owned < self.s.max_teacher_active

    def assert_authorization(self, conn, ex):
        lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == ex['session_id'])
        if lifecycle and lifecycle['closed'] is not None:
            raise InputError('SESSION_CLOSED')
        scope = row(conn, scope_table, scope_table.c.execution_id == ex["id"])
        if not scope or scope["valid_until"] <= time.time():
            raise InputError("AUTHORIZATION_EXPIRED")

    def teaching_request(self, identity, action, **extra):
        if identity["login_expires_at"] <= time.time():
            raise InputError("AUTHORIZATION_REVOKED")
        path = "/internal/teacher-agent/tools"
        body = canonical({"action": action, **{k: identity[k] for k in ("course", "teacher_id", "login_ref")}, **extra}).encode()
        now = int(time.time())
        signed = sign({"v": 1, "iss": "teacher-agent", "aud": "teaching-tools", "iat": now, "exp": now + 30,
                       "deployment_id": self.s.teaching_deployment, "method": "POST", "path": path,
                       "body_sha256": hashlib.sha256(body).hexdigest()}, self.s.teaching_tool_key)
        try:
            with httpx.Client(timeout=2 if action == "authorize" else 4, trust_env=False, follow_redirects=False) as client:
                response = client.post(self.s.teaching_url + path, content=body,
                    headers={"Content-Type": "application/json", "X-Agent-Tool-Assertion": signed})
                if response.status_code in {401, 403}:
                    raise InputError("AUTHORIZATION_REVOKED")
                if response.status_code in {400, 404} and action == "tool":
                    raise InputError("TEACHING_RECORD_NOT_FOUND_OR_INVALID")
                response.raise_for_status()
                if len(response.content) > 256000:
                    raise InputError("TOOL_RESULT_LIMIT")
                return response.json()
        except httpx.HTTPError:
            raise InputError("AUTHORIZATION_UNAVAILABLE") from None

    def refresh_authorization(self, eid):
        with self.db.tx() as conn:
            scope = row(conn, scope_table, scope_table.c.execution_id == eid)
        if not scope:
            raise InputError("AUTHORIZATION_REVOKED")
        checked_at = time.time()
        self.teaching_request(scope["identity"], "authorize")
        with self.db.tx(durable=False) as conn:
            ex = row(conn, executions, executions.c.id == eid)
            self.db.lock_session(conn, ex["session_id"])
            current = row(conn, scope_table, scope_table.c.execution_id == eid)
            if current["identity"] == scope["identity"]:
                conn.execute(update(scope_table).where(scope_table.c.execution_id == eid).values(
                    valid_until=min(checked_at + 5, scope["identity"]["login_expires_at"])))

    def invoke(self, tool, args, opid, token, ex):
        if tool["kind"] != "teaching" or tool["effect"] != "read":
            raise PermissionError("Teaching supports read-only tools")
        with self.db.tx() as conn:
            self.lock_capability(conn, token)
            scope = row(conn, scope_table, scope_table.c.execution_id == ex["id"])
        result = self.teaching_request(scope["identity"], "tool", tool=tool["name"], arguments=args)
        evidence = {"id": opid, "tool": tool["name"], "arguments": args,
                    "retrieved_at": result.get("retrieved_at"), "source_version": result.get("source_version"),
                    "scope": result.get("scope")}
        with self.db.tx() as conn:
            a, current = self.lock_capability(conn, token)
            self.db.event(conn, current["id"], "tool.evidence", evidence, a["id"])
        return {"content": [{"type": "text", "text": canonical({"evidence": evidence, **result})}]}

    def briefing(self, conn, ex, session):
        prompt, files = super().briefing(conn, ex, session)
        scope = row(conn, scope_table, scope_table.c.execution_id == ex["id"])
        # Never put login references or service credentials into the sandbox.
        context = {"course": scope["identity"]["course"], "selection": scope["page_context"],
                   "capability_version": VERSION, "read_only": True}
        files["context/teaching.json"] = canonical(context).encode()
        prompt += "\nRead context/teaching.json for the validated course and page selection. Use teaching tools for current records; cite evidence IDs. A draft is never a published task or grade."
        self.blobs.validate_files(files)
        return prompt, files

    def upload(self, tenant, sid, name, data):
        with self.db.tx() as conn:
            self.lock_capacity(conn)
            self.require_open_session(conn, tenant, sid)
        if not isinstance(name, str) or not re.fullmatch(r"[^/\\\x00-\x1f]{1,150}\.(txt|csv)", name, re.I):
            raise InputError("TXT_OR_CSV_REQUIRED")
        try:
            data.decode("utf-8-sig")
        except UnicodeError:
            raise InputError("UTF8_TEXT_REQUIRED") from None
        return super().upload(tenant, sid, name, data)

    def resume_teacher(self, principal, eid):
        # Renew the identity only on an explicit action from the same tenant.
        with self.db.tx() as conn:
            self.lock_capacity(conn)
            ex = self.execution(conn, principal["tenant"], eid)
            self.db.lock_session(conn, ex["session_id"])
            self.require_open_session(conn, principal['tenant'], ex['session_id'])
            self.before_submit(conn, principal, ex['session_id'])
            if ex["state"] != "WAITING_INPUT":
                raise InputError("Execution is not waiting for input")
            conn.execute(update(scope_table).where(scope_table.c.execution_id == eid).values(identity=principal["identity"], valid_until=0))
        return super().resume(principal["tenant"], eid)


def initialize_teaching(db):
    # Explicit init command only; create_all is not an upgrade/migration mechanism.
    with db.tx() as conn:
        if not row(conn, capacity, capacity.c.id == "global"):
            conn.execute(insert(capacity).values(id="global"))


def make_service(settings, db, blobs):
    return (TeachingService if settings.teaching_mode else Service)(settings, db, blobs)


def page_query(service, tenant, *, sid=None, cursor=None, limit=20):
    if not 1 <= limit <= 100:
        raise InputError("INVALID_PAGE_LIMIT")
    with service.db.tx() as conn:
        table = executions if sid else sessions
        query = select(table).where(table.c.tenant == tenant)
        if sid:
            service.session(conn, tenant, sid)
            query = query.where(table.c.session_id == sid)
        if cursor:
            previous = row(conn, table, (table.c.id == cursor) & (table.c.tenant == tenant))
            if not previous or (sid and previous["session_id"] != sid):
                raise InputError("INVALID_CURSOR")
            query = query.where((table.c.created < previous["created"]) | ((table.c.created == previous["created"]) & (table.c.id < cursor)))
        rows = list(conn.execute(query.order_by(table.c.created.desc(), table.c.id.desc()).limit(limit + 1)).mappings())
        more = len(rows) > limit
        rows = rows[:limit]
        items = []
        for r in rows:
            if sid:
                ev = list(conn.execute(select(events).where((events.c.execution_id == r["id"]) & events.c.type.in_(["artifact.created", "tool.evidence"])).order_by(events.c.seq)).mappings())
                items.append({"execution_id": r["id"], "message": r["prompt"], "state": r["state"], "result": r["result"], "error": r["error"],
                              "artifacts": [e["payload"] for e in ev if e["type"] == "artifact.created"],
                              "evidence": [e["payload"] for e in ev if e["type"] == "tool.evidence"]})
            else:
                info = row(conn, session_info, session_info.c.session_id == r["id"])
                lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == r['id'])
                items.append({"id": r["id"], "title": info["title"] if info else "新对话", "created": r["created"],
                              'closed': bool(lifecycle and lifecycle['closed'] is not None)})
        result = {"items": list(reversed(items)) if sid else items, "next_cursor": rows[-1]["id"] if more else None}
        if sid:
            lifecycle = row(conn, session_lifecycle, session_lifecycle.c.session_id == sid)
            result['session'] = {'id':sid, 'closed':bool(lifecycle and lifecycle['closed'] is not None),
                                 'sandbox_expires_at':lifecycle['sandbox_expires'] if lifecycle else 0}
        return result
