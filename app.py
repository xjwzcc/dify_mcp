import json
import os
import uvicorn
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from mcp.server import Server
from mcp.server.sse import SseServerTransport
import mcp.types as types

# ========== 1. 初始化 MCP Server ==========
server = Server("wenjing-hotel-mcp")

# ========== 2. MCP 工具定义区 ==========

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="check_room_availability",
            description="查询酒店特定日期的房态和价格",
            inputSchema={
                "type": "object",
                "properties": {
                    "room_type": {"type": "string", "description": "房型(例如: 莳月·宜家, 莳光·景观房)"},
                    "check_in_date": {"type": "string", "description": "入住日期 (YYYY-MM-DD)"}
                },
                "required": ["room_type", "check_in_date"]
            }
        ),
        types.Tool(
            name="get_nanjing_weather",
            description="查询南京老门东景区的天气预报，用于行程规划",
            inputSchema={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "日期 (例如: 今天, 明天, 2024-05-01)"}
                },
                "required": ["date"]
            }
        ),
        types.Tool(
            name="plan_travel_route",
            description="规划从酒店(老门东)出发到周边景点的交通路线",
            inputSchema={
                "type": "object",
                "properties": {
                    "destination": {"type": "string", "description": "目的地名称 (例如: 夫子庙, 南京博物院)"}
                },
                "required": ["destination"]
            }
        )
    ]


@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    if name == "check_room_availability":
        room_type = arguments.get("room_type", "")
        check_in_date = arguments.get("check_in_date", "")
        mock_db = {
            "莳月·宜家": {"price": 599, "status": "有房", "left": 2},
            "莳光·景观房": {"price": 398, "status": "满房", "left": 0},
            "莳光·VR视界": {"price": 458, "status": "有房", "left": 1},
            "莳雨小院": {"price": 428, "status": "有房", "left": 4}
        }
        result = mock_db.get(room_type, {"price": 450, "status": "有房", "left": 5})
        return [types.TextContent(type="text", text=json.dumps({
            "hotel": "南京老门东金陵文璟酒店",
            "date": check_in_date,
            "room_type": room_type,
            "details": result
        }, ensure_ascii=False))]

    elif name == "get_nanjing_weather":
        return [types.TextContent(type="text", text="南京老门东明天小雨转阴，气温 15℃-20℃，适合在酒店明清庭院内喝茶，或带把伞漫步老门东青石板路。")]

    elif name == "plan_travel_route":
        destination = arguments.get("destination", "")
        routes = {
            "夫子庙": "距离酒店约1公里，建议步行前往，用时约15分钟，沿途可欣赏秦淮河夜景。",
            "南京博物院": "距离较远，建议在武定门地铁站乘坐地铁3号线转2号线，全程约40分钟；打车约20分钟。",
            "中华门": "距离极近，就在老门东旁边，步行 5 分钟即可到达，强烈推荐夜游城墙。"
        }
        return [types.TextContent(type="text", text=routes.get(destination, f"已为您查询到前往 {destination} 的路线：建议打车前往，让前台为您呼叫专车。"))]

    raise ValueError(f"Unknown tool: {name}")


# ========== 3. SSE 传输层配置 ==========

sse = SseServerTransport("/messages")


async def handle_sse(request: Request):
    """
    建立 MCP SSE 长连接。
    关键：通过 request._send 获取原始 ASGI send callable，
    而非 FastAPI 包装后的 request.send。
    """
    async with sse.connect_sse(
        request.scope,
        request.receive,
        request._send,
    ) as streams:
        await server.run(
            streams[0],
            streams[1],
            server.create_initialization_options(),
        )


async def handle_messages(request: Request):
    """处理来自 Dify/客户端的 JSON-RPC 工具调用请求"""
    await sse.handle_post_message(
        request.scope,
        request.receive,
        request._send,
    )


async def homepage(request: Request):
    """健康检查端点"""
    return JSONResponse({
        "message": "Wenjing Hotel MCP Server is running! Connect to /sse for MCP endpoints."
    })


# ========== 4. 构建 Starlette 应用 ==========
# 不使用 FastAPI，避免中间件栈对 SSE 流式响应的干扰

app = Starlette(
    debug=True,
    routes=[
        Route("/", homepage),
        Route("/sse", handle_sse),
        Route("/messages", handle_messages, methods=["POST"]),
    ],
    middleware=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ],
)


# ========== 5. 启动入口 ==========
if __name__ == "__main__":
    # 阿里云 FC 默认监听 9000 端口
    port = int(os.environ.get("PORT", 9000))
    uvicorn.run("app:app", host="0.0.0.0", port=port)