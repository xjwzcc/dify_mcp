import asyncio
import json
import secrets
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse, FileResponse
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import select

from .config import Settings
from .db import Database, artifacts, attempts, events, executions, operations, row
from .storage import Blobs, InputError
from .service import Service, TERMINAL
from .gateway import Gateway
from .teaching import TeachingAuthentication, make_service, page_query


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str
    message: str
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    skill_refs: list[str] = Field(default_factory=list, max_length=8)
    capability_profile: str = "default"
    page_context: dict = Field(default_factory=dict)


def bearer(request):
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise PermissionError("Bearer authorization required")
    return auth[7:]


class BodyLimit:
    def __init__(self, app, limit):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                return
            data = msg.get("body", b"")
            size += len(data)
            if size > self.limit:
                return await JSONResponse({"error": "REQUEST_TOO_LARGE"}, status_code=413)(scope, receive, send)
            chunks.append(data)
            if not msg.get("more_body"):
                break
        pending = True

        async def replay():
            nonlocal pending
            if pending:
                pending = False
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def create_app(settings=None, service=None):
    settings = settings or Settings.from_env()
    settings.validate()
    if service is None:
        db = Database(settings)
        service = make_service(settings, db, Blobs(settings))
    app = FastAPI(title="Sandbox Chat", docs_url=None, redoc_url=None)
    if settings.teaching_mode:
        app.add_middleware(TeachingAuthentication, settings=settings)
    app.add_middleware(BodyLimit, limit=max(settings.max_input_bytes, settings.max_file_bytes) + 64000)
    app.state.service = service
    gateway = Gateway(service)
    app.state.gateway = gateway

    @app.exception_handler(PermissionError)
    async def forbidden(_, exc):
        return JSONResponse({"error": str(exc)}, status_code=403)

    @app.exception_handler(KeyError)
    async def missing(_, exc):
        return JSONResponse({"error": "Not found"}, status_code=404)

    @app.exception_handler(ValueError)
    async def invalid(_, exc):
        code = str(exc)[:300]
        return JSONResponse({"error": code}, status_code=429 if code == "TEACHER_QUEUE_FULL" else 409 if code == "REQUEST_ID_CONFLICT" else 400)

    def principal(request):
        if settings.teaching_mode:
            return request.state.teacher_principal
        return service.principal(bearer(request))

    @app.get("/health")
    def health():
        if settings.teaching_mode:
            try:
                with service.db.tx() as conn:
                    service.lock_capacity(conn)
            except Exception:
                return JSONResponse({"ok": False, "reason": "DATABASE_NOT_READY"}, 503)
        return {"ok": True, "protocol": 1}

    @app.get("/")
    def index():
        if settings.teaching_mode:
            raise HTTPException(404)
        return FileResponse(Path(__file__).parent / "static/index.html",
                            headers={"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"})

    @app.get("/app.js")
    def js():
        if settings.teaching_mode:
            raise HTTPException(404)
        return FileResponse(Path(__file__).parent / "static/app.js", media_type="application/javascript")

    @app.get("/style.css")
    def css():
        if settings.teaching_mode:
            raise HTTPException(404)
        return FileResponse(Path(__file__).parent / "static/style.css", media_type="text/css")

    @app.post("/api/chat/sessions")
    async def new_session(request: Request):
        if settings.teaching_mode:
            body = await request.json()
            if not isinstance(body, dict) or set(body) - {"request_id", "title"}:
                raise InputError("INVALID_SESSION_REQUEST")
            return await asyncio.to_thread(service.create_teacher_session, principal(request), body.get("request_id"), body.get("title", "新对话"))
        return service.create_session(principal(request)["tenant"])

    @app.get("/api/chat/sessions")
    def list_sessions(request: Request, cursor: str | None = None, limit: int = 20):
        return page_query(service, principal(request)["tenant"], cursor=cursor, limit=limit)

    @app.post("/api/chat/sessions/{sid}/attachments")
    async def upload(sid: str, request: Request, name: str):
        who = principal(request)
        return await asyncio.to_thread(service.upload, who["tenant"], sid, name, await request.body())

    @app.post("/api/chat/sessions/{sid}/messages", status_code=202)
    def message(sid: str, body: Message, request: Request):
        who = principal(request)
        if settings.teaching_mode:
            if body.model_fields_set - {"request_id", "message", "attachment_ids", "page_context"}:
                raise InputError("SERVER_OWNED_CAPABILITIES")
            who = {**who, "page_context": body.page_context}
            skills, profile = ["teaching-assistant"], who["identity"]["course"] + "-teacher"
        else:
            skills, profile = body.skill_refs, body.capability_profile
        eid = service.submit(who, sid, body.request_id, body.message, body.attachment_ids, skills, profile)
        return {"execution_id": eid, "events_url": "/api/chat/executions/" + eid + "/events"}

    @app.get("/api/chat/executions/{eid}")
    def status(eid: str, request: Request):
        with service.db.tx() as conn:
            ex = service.execution(conn, principal(request)["tenant"], eid)
            return {k: ex[k] for k in ("id", "session_id", "state", "attempt_no", "result", "error")}

    @app.post("/api/chat/executions/{eid}/cancel")
    def cancel(eid: str, request: Request):
        service.cancel(principal(request)["tenant"], eid)
        return {"ok": True}

    @app.post("/api/chat/executions/{eid}/resume")
    def resume(eid: str, request: Request):
        if settings.teaching_mode:
            service.resume_teacher(principal(request), eid)
        else:
            service.resume(principal(request)["tenant"], eid)
        return {"ok": True}

    @app.get("/api/chat/sessions/{sid}/operations")
    def operation_history(sid: str, request: Request):
        with service.db.tx() as conn:
            service.session(conn, principal(request)["tenant"], sid)
            return [dict(x) for x in conn.execute(select(operations).join(executions,
                executions.c.id == operations.c.execution_id).where(executions.c.session_id == sid)).mappings()]

    @app.post("/internal/operations/{opid}/resolve")
    def resolve(opid: str, body: dict, request: Request):
        if not settings.admin_key or not secrets.compare_digest(bearer(request), settings.admin_key):
            raise PermissionError("Operator authorization required")
        service.resolve_operation(opid, body.get("outcome"), body.get("evidence"))
        return {"ok": True}

    @app.get("/api/chat/sessions/{sid}/history")
    def history(sid: str, request: Request, cursor: str | None = None, limit: int = 50):
        tenant = principal(request)["tenant"]
        if settings.teaching_mode:
            return page_query(service, tenant, sid=sid, cursor=cursor, limit=limit)
        with service.db.tx() as conn:
            service.session(conn, tenant, sid)
            items = conn.execute(select(executions).where(executions.c.session_id == sid)
                                 .order_by(executions.c.created, executions.c.id)).mappings()
            return [{"execution_id": e["id"], "message": e["prompt"], "state": e["state"],
                     "result": e["result"], "error": e["error"]} for e in items]

    @app.get("/api/chat/executions/{eid}/events")
    def stream(eid: str, request: Request, after: int = 0):
        tenant = principal(request)["tenant"]
        cursor = max(after, int(request.headers.get("last-event-id", "0")))
        with service.db.tx() as conn:
            service.execution(conn, tenant, eid)

        def fetch(after):
            with service.db.tx() as conn:
                ex = service.execution(conn, tenant, eid)
                batch = [dict(x) for x in conn.execute(select(events).where(
                    (events.c.execution_id == eid) & (events.c.seq > after))
                    .order_by(events.c.seq).limit(200)).mappings()]
                return ex, batch

        async def generate():
            nonlocal cursor
            runtime = getattr(service, 'runtime', None)
            if runtime:
                runtime.acquire(eid)
            try:
                until = time.monotonic() + (settings.attempt_seconds + 60 if runtime else 50)
                while time.monotonic() < until and not await request.is_disconnected():
                    revision = getattr(service.db, 'revision', 0)
                    ex, batch = await asyncio.to_thread(fetch, cursor)
                    for event in batch:
                        cursor = event["seq"]
                        yield "id: " + str(cursor) + "\ndata: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                    if not batch and ex["state"] in TERMINAL | {"WAITING_INPUT", "WAITING_DEPENDENCY"}:
                        return
                    if not batch:
                        yield ": heartbeat\n\n"
                        if hasattr(service.db, 'wait_for_change'):
                            await asyncio.to_thread(service.db.wait_for_change, revision)
                        else:
                            await asyncio.sleep(0.5)
            finally:
                if runtime:
                    # Cancellation cannot skip fencing. OS sandbox TTL is an additional bound.
                    await asyncio.shield(asyncio.to_thread(runtime.release,eid))
        return StreamingResponse(generate(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/chat/artifacts/{aid}/download")
    def download(aid: str, request: Request):
        tenant = principal(request)["tenant"]
        with service.db.tx() as conn:
            item = row(conn, artifacts, artifacts.c.id == aid)
            if not item or item["tenant"] != tenant:
                raise KeyError("Artifact not found")
        return Response(service.blobs.get(item["ref"]), media_type="application/octet-stream",
                        headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(item["name"], safe=""),
                                 "X-Content-Type-Options": "nosniff"})

    @app.get("/v1/models")
    def models(request: Request):
        with service.db.tx() as conn:
            service.lock_capability(conn, bearer(request))
        return {"object": "list", "data": [{"id": settings.model, "object": "model"}]}

    @app.post("/v1/responses")
    def responses(body: dict, request: Request):
        status_code, value, iterator = app.state.gateway.open(bearer(request), body)
        if iterator is not None:
            return StreamingResponse(iterator, media_type="text/event-stream")
        return JSONResponse(value, status_code=status_code)

    @app.post("/v1/responses/compact")
    def compact(request: Request):
        with service.db.tx() as conn:
            service.lock_capability(conn, bearer(request))
        return JSONResponse({"error": {"code": "REMOTE_COMPACTION_UNSUPPORTED"}}, status_code=400)

    @app.post("/internal/tools")
    def tools(body: dict, request: Request):
        token = bearer(request)
        if body.get("method") == "tools/list":
            return {"tools": service.tool_list(token)}
        if body.get("method") == "tools/call":
            p = body["params"]
            return service.tool_call(token, p["name"], p.get("arguments", {}))
        raise InputError("Unsupported method")

    @app.post("/internal/events")
    def event(body: dict, request: Request):
        return {"seq": service.emit(bearer(request), body["type"], body["payload"], body["source_id"])}

    @app.post("/internal/tick")
    def tick(request: Request):
        if settings.teaching_mode:
            raise HTTPException(409, "Teaching requires the resident worker with independent authorization renewal")
        if not settings.admin_key or not secrets.compare_digest(bearer(request), settings.admin_key):
            raise PermissionError("Scheduler authorization required")
        from .worker import Worker
        # A bounded lifecycle step, never background execution after returning.
        Worker(service).tick()
        return {"ok": True}
    return app
