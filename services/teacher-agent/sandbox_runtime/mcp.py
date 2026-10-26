"""MCP stdio client for the externally authorized Tool Broker."""
import json
import os
import sys
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    reply = {"jsonrpc": "2.0", "id": request["id"]}
    try:
        method = request["method"]
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "sandbox-business-tools", "version": "0.1.0"}}
        elif method == "ping":
            result = {}
        elif method in {"tools/list", "tools/call"}:
            outgoing = urllib.request.Request(os.environ["GATEWAY_URL"] + "/internal/tools",
                data=json.dumps(request).encode(), headers={"Content-Type": "application/json",
                "Authorization": "Bearer " + os.environ["ATTEMPT_TOKEN"]})
            with opener.open(outgoing, timeout=70) as response:
                result = json.load(response)
        else:
            raise ValueError("METHOD_NOT_ALLOWED")
        reply["result"] = result
    except Exception:
        reply["error"] = {"code": -32603, "message": "Tool call rejected or unavailable; consult host status"}
    print(json.dumps(reply), flush=True)
