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
            description="规划两个地点之间的交通路线",
            inputSchema={
                "type": "object",
                "properties": {
                    "origin": {"type": "string", "description": "出发地名称 (例如: 南京老门东金陵文璟酒店)"},
                    "destination": {"type": "string", "description": "目的地名称 (例如: 夫子庙, 南京博物院)"},
                    "mode": {"type": "string", "description": "出行方式 (例如: 走路, 驾车, 公交, 骑行)", "default": "走路"}
                },
                "required": ["origin", "destination"]
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
        import requests
        origin = arguments.get("origin", "")
        destination = arguments.get("destination", "")
        mode = arguments.get("mode", "走路")
        key = "9a5da29d0bd9a60ec2d58e01757e86f5"

        def get_location(address):
            url = f"https://restapi.amap.com/v3/geocode/geo?address={address}&city=南京&key={key}"
            try:
                res = requests.get(url, timeout=5).json()
                if res.get('status') == '1' and res.get('geocodes'):
                    return res['geocodes'][0]['location']
            except Exception:
                pass
            return None

        origin_loc = get_location(origin)
        dest_loc = get_location(destination)

        if not origin_loc or not dest_loc:
            return [types.TextContent(type="text", text=f"无法获取 {origin} 或 {destination} 的位置信息，请尝试其他地址。")]

        try:
            if mode == "驾车":
                url = f"https://restapi.amap.com/v3/direction/driving?origin={origin_loc}&destination={dest_loc}&key={key}"
                res = requests.get(url, timeout=5).json()
                if res.get('status') == '1' and res.get('route', {}).get('paths'):
                    path = res['route']['paths'][0]
                    distance = int(path['distance'])
                    duration = int(path['duration']) // 60
                    return [types.TextContent(type="text", text=f"已为您查询到前往 {destination} 的路线：建议驾车前往，距离约 {distance} 米，预计用时 {duration} 分钟。")]
            elif mode == "公交":
                url = f"https://restapi.amap.com/v3/direction/transit/integrated?origin={origin_loc}&destination={dest_loc}&city=南京&key={key}"
                res = requests.get(url, timeout=5).json()
                if res.get('status') == '1' and res.get('route', {}).get('transits'):
                    path = res['route']['transits'][0]
                    distance = int(path['distance'])
                    duration = int(path['duration']) // 60
                    return [types.TextContent(type="text", text=f"已为您查询到前往 {destination} 的路线：建议乘坐公共交通，距离约 {distance} 米，预计用时 {duration} 分钟。")]
            elif mode == "骑行":
                url = f"https://restapi.amap.com/v4/direction/bicycling?origin={origin_loc}&destination={dest_loc}&key={key}"
                res = requests.get(url, timeout=5).json()
                if res.get('errcode') == 0 and res.get('data', {}).get('paths'):
                    path = res['data']['paths'][0]
                    distance = int(path['distance'])
                    duration = int(path['duration']) // 60
                    return [types.TextContent(type="text", text=f"已为您查询到前往 {destination} 的路线：建议骑行前往，距离约 {distance} 米，预计用时 {duration} 分钟。")]
            else:  # 默认走路
                url = f"https://restapi.amap.com/v3/direction/walking?origin={origin_loc}&destination={dest_loc}&key={key}"
                res = requests.get(url, timeout=5).json()
                if res.get('status') == '1' and res.get('route', {}).get('paths'):
                    path = res['route']['paths'][0]
                    distance = int(path['distance'])
                    duration = int(path['duration']) // 60
                    return [types.TextContent(type="text", text=f"已为您查询到前往 {destination} 的路线：建议步行前往，距离约 {distance} 米，预计用时 {duration} 分钟。")]
        except Exception as e:
            return [types.TextContent(type="text", text=f"查询前往 {destination} 的路线时发生错误：{str(e)}")]

        return [types.TextContent(type="text", text=f"未能找到合适的 {mode} 路线前往 {destination}。")]

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