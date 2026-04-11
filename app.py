import json
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from mcp.server import Server
from mcp.server.sse import SseServerTransport

# 1. 初始化 FastAPI 和 MCP Server
app = FastAPI(title="金陵文璟酒店专属管家 MCP Server")
server = Server("wenjing-hotel-mcp")

# 添加 CORS 支持，Render 部署时可能需要
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import mcp.types as types

# ----------------- MCP 工具定义区 -----------------

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


# ----------------- MCP SSE 传输层配置 -----------------

# 配置 SSE 消息接收路径
sse = SseServerTransport("/messages")

@app.get("/sse")
async def handle_sse(request: Request):
    """建立 MCP SSE 长连接"""
    async with sse.connect_sse(request.scope, request.receive, request.send) as streams:
        await server.run(streams[0], streams[1], server.create_initialization_options())

@app.post("/messages")
async def handle_messages(request: Request):
    """处理来自 Dify 的 JSON-RPC 工具调用请求"""
    await sse.handle_post_message(request.scope, request.receive, request.send)

@app.get("/")
async def root():
    return {"message": "Wenjing Hotel MCP Server is running! Connect to /sse for MCP endpoints."}

# ----------------- 启动入口 -----------------
if __name__ == "__main__":
    # Render 会自动注入 PORT 环境变量，默认监听 0.0.0.0
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
