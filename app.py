"""
南京老门东金陵文璟酒店 - 完整 MCP Server
部署平台：阿里云 FC 函数计算
传输协议：SSE (Server-Sent Events)

外部服务依赖：
1. 高德地图 API - 路线规划、地理编码、POI搜索
2. 和风天气 API - 天气预报查询
3. 酒店 PMS/自建数据库 - 房态、价格、订单管理
4. 工单系统 API - 投诉/服务工单管理
5. 携程/OTA API（可选） - 订单同步
"""

import json
import os
import logging
import hashlib
from datetime import datetime, timedelta
from typing import Optional

import uvicorn
import requests
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from mcp.server import Server
from mcp.server.sse import SseServerTransport
import mcp.types as types

# ========== 日志配置 ==========
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("wenjing-hotel-mcp")

# ========== 环境变量配置 ==========
AMAP_KEY = os.environ.get("AMAP_KEY", "9a5da29d0bd9a60ec2d58e01757e86f5")
QWEATHER_KEY = os.environ.get("QWEATHER_KEY", "your_qweather_key_here")  # 和风天气Key
HOTEL_API_BASE = os.environ.get("HOTEL_API_BASE", "")  # 酒店PMS API 地址
HOTEL_API_TOKEN = os.environ.get("HOTEL_API_TOKEN", "")  # 酒店PMS Token

# 酒店坐标（老门东金陵文璟酒店）
HOTEL_LOCATION = "118.786852,32.015908"
HOTEL_NAME = "南京老门东金陵文璟酒店"
HOTEL_ADDRESS = "南京市秦淮区夫子庙街道边营43号"
HOTEL_PHONE = "025-XXXXXXXX"

# ========== 1. 初始化 MCP Server ==========
server = Server("wenjing-hotel-mcp")


# =====================================================================
#  辅助函数
# =====================================================================

def amap_geocode(address: str, city: str = "南京") -> Optional[str]:
    """高德地图地理编码：地址 -> 经纬度"""
    url = "https://restapi.amap.com/v3/geocode/geo"
    params = {"address": address, "city": city, "key": AMAP_KEY}
    try:
        res = requests.get(url, params=params, timeout=5).json()
        if res.get("status") == "1" and res.get("geocodes"):
            return res["geocodes"][0]["location"]
    except Exception as e:
        logger.error(f"Geocode error: {e}")
    return None


def amap_poi_search(keywords: str, types_code: str = "", 
                     center: str = HOTEL_LOCATION, radius: int = 3000) -> list:
    """高德地图 POI 搜索：以酒店为中心搜索周边"""
    url = "https://restapi.amap.com/v3/place/around"
    params = {
        "key": AMAP_KEY,
        "keywords": keywords,
        "types": types_code,
        "location": center,
        "radius": radius,
        "offset": 10,  # 返回条数
        "sortrule": "distance",
        "extensions": "all"
    }
    try:
        res = requests.get(url, params=params, timeout=5).json()
        if res.get("status") == "1" and res.get("pois"):
            return res["pois"]
    except Exception as e:
        logger.error(f"POI search error: {e}")
    return []


def format_distance(meters: int) -> str:
    """格式化距离显示"""
    if meters < 1000:
        return f"{meters}米"
    return f"{meters / 1000:.1f}公里"


def format_duration(seconds: int) -> str:
    """格式化时长显示"""
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}分钟"
    hours = minutes // 60
    remaining = minutes % 60
    return f"{hours}小时{remaining}分钟"


# =====================================================================
#  房态 & 订单模拟数据库
#  实际生产中应替换为酒店 PMS 系统 API 调用
# =====================================================================

ROOM_DATABASE = {
    "莳月·宜家": {
        "room_type_id": "RT001",
        "name": "莳月·宜家",
        "category": "大床房",
        "area": 30,
        "bed_type": "1.8m大床",
        "floor": "2-4层",
        "max_guests": 2,
        "base_price": 599,
        "weekend_price": 699,
        "holiday_price": 899,
        "facilities": ["智能客控", "55寸电视", "独立卫浴", "雨淋花洒", "迷你吧"],
        "description": "高级大床房，简约舒适",
        "breakfast": "可选含早",
        "child_friendly": False
    },
    "莳光·景观房": {
        "room_type_id": "RT002",
        "name": "莳光·景观房",
        "category": "景观房",
        "area": 35,
        "bed_type": "1.8m大床",
        "floor": "3-4层",
        "max_guests": 2,
        "base_price": 398,
        "weekend_price": 498,
        "holiday_price": 698,
        "facilities": ["智能客控", "庭院景观", "独立卫浴", "品牌洗浴"],
        "description": "可观苏州园林式庭院景观",
        "breakfast": "含单早",
        "child_friendly": False
    },
    "莳光·VR视界": {
        "room_type_id": "RT003",
        "name": "莳光·VR视界",
        "category": "科技主题房",
        "area": 32,
        "bed_type": "1.8m大床",
        "floor": "2-3层",
        "max_guests": 2,
        "base_price": 458,
        "weekend_price": 558,
        "holiday_price": 758,
        "facilities": ["VR设备", "智能客控", "游戏主机", "投影仪"],
        "description": "科技感满满的VR主题房，适合年轻人",
        "breakfast": "可选含早",
        "child_friendly": False
    },
    "莳雨小院": {
        "room_type_id": "RT004",
        "name": "莳雨小院",
        "category": "庭院房",
        "area": 45,
        "bed_type": "1.8m大床",
        "floor": "1层",
        "max_guests": 3,
        "base_price": 428,
        "weekend_price": 528,
        "holiday_price": 828,
        "facilities": ["私家小院", "户外茶座", "智能客控", "浴缸"],
        "description": "独立小院，可在院中品茶赏景",
        "breakfast": "含双早",
        "child_friendly": True
    },
    "亲子主题房": {
        "room_type_id": "RT005",
        "name": "亲子主题房",
        "category": "亲子房",
        "area": 40,
        "bed_type": "1.8m大床 + 儿童床",
        "floor": "2-3层",
        "max_guests": 4,
        "base_price": 800,
        "weekend_price": 1000,
        "holiday_price": 1200,
        "facilities": ["卡通装饰", "儿童洗漱用品", "儿童拖鞋浴袍", "智能客控"],
        "description": "专为亲子家庭设计，含免费儿童乐园使用权",
        "breakfast": "含双早，1.2m以下儿童免费",
        "child_friendly": True,
        "extra_benefits": ["免费儿童乐园", "儿童欢迎礼包"]
    },
    "复式Loft房": {
        "room_type_id": "RT006",
        "name": "复式Loft房",
        "category": "Loft",
        "area": 50,
        "bed_type": "上层1.8m大床 + 下层客厅可加床",
        "floor": "特殊楼层",
        "max_guests": 4,
        "base_price": 1000,
        "weekend_price": 1200,
        "holiday_price": 1500,
        "facilities": ["复式设计", "独立客厅", "智能客控", "浴缸"],
        "description": "50㎡复式空间，上层卧室+下层客厅，部分可观园景",
        "breakfast": "含双早",
        "child_friendly": True,
        "extra_benefits": ["部分园景"]
    }
}

# 模拟房态库存（实际应从PMS获取）
def get_room_inventory(room_type: str, date: str) -> dict:
    """
    获取指定日期的房态库存
    生产环境：调用酒店 PMS API
    当前：模拟数据
    """
    room = ROOM_DATABASE.get(room_type)
    if not room:
        return {"available": False, "error": "未找到该房型"}
    
    # 判断日期类型来决定价格
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        weekday = dt.weekday()
        
        # 简单模拟：周五六为周末价，节假日另算
        holidays = ["2026-05-01", "2026-05-02", "2026-05-03", 
                     "2026-10-01", "2026-10-02", "2026-10-03"]
        
        if date in holidays:
            price = room["holiday_price"]
            price_type = "节假日价"
        elif weekday >= 4:  # 周五、周六
            price = room["weekend_price"]
            price_type = "周末价"
        else:
            price = room["base_price"]
            price_type = "平日价"
    except ValueError:
        price = room["base_price"]
        price_type = "参考价"
    
    # 模拟库存（实际从PMS获取）
    import random
    random.seed(hashlib.md5(f"{room_type}{date}".encode()).hexdigest())
    remaining = random.randint(0, 5)
    
    return {
        "available": remaining > 0,
        "remaining": remaining,
        "price": price,
        "price_type": price_type,
        "room_info": room
    }


# 模拟订单存储
ORDERS_DB = {}

def create_order(order_data: dict) -> dict:
    """
    创建预订订单
    生产环境：调用酒店 PMS API 或 OTA API
    当前：模拟数据
    """
    order_id = f"WJ{datetime.now().strftime('%Y%m%d%H%M%S')}"
    order = {
        "order_id": order_id,
        "status": "已确认",
        "hotel": HOTEL_NAME,
        "created_at": datetime.now().isoformat(),
        **order_data
    }
    ORDERS_DB[order_id] = order
    return order


# 模拟工单系统
TICKETS_DB = {}

def create_ticket(ticket_data: dict) -> dict:
    """
    创建服务工单
    生产环境：调用酒店内部工单系统 API
    当前：模拟数据
    """
    ticket_id = f"TK{datetime.now().strftime('%Y%m%d%H%M%S')}"
    ticket = {
        "ticket_id": ticket_id,
        "status": "待处理",
        "hotel": HOTEL_NAME,
        "created_at": datetime.now().isoformat(),
        **ticket_data
    }
    TICKETS_DB[ticket_id] = ticket
    return ticket


# =====================================================================
#  2. MCP 工具定义
# =====================================================================

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        # ==================== 房态 & 预订类 ====================
        types.Tool(
            name="check_room_availability",
            description="查询酒店指定日期的房型可用情况和实时价格。支持查询所有房型或指定房型。返回房型名称、价格、剩余房量、设施列表等详细信息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "check_in_date": {
                        "type": "string",
                        "description": "入住日期，格式 YYYY-MM-DD，例如 2026-04-15"
                    },
                    "check_out_date": {
                        "type": "string",
                        "description": "离店日期，格式 YYYY-MM-DD，例如 2026-04-17"
                    },
                    "room_type": {
                        "type": "string",
                        "description": "指定房型名称（可选）。不传则返回所有可用房型。可选值：莳月·宜家, 莳光·景观房, 莳光·VR视界, 莳雨小院, 亲子主题房, 复式Loft房",
                        "default": ""
                    },
                    "guest_count": {
                        "type": "integer",
                        "description": "入住人数（含儿童），用于筛选合适房型",
                        "default": 2
                    },
                    "has_children": {
                        "type": "boolean",
                        "description": "是否有儿童同行，用于优先推荐亲子房型",
                        "default": False
                    }
                },
                "required": ["check_in_date"]
            }
        ),
        types.Tool(
            name="create_reservation",
            description="为客人创建酒店预订订单。需要提供入住日期、离店日期、房型、客人姓名和联系电话。",
            inputSchema={
                "type": "object",
                "properties": {
                    "room_type": {
                        "type": "string",
                        "description": "预订的房型名称"
                    },
                    "check_in_date": {
                        "type": "string",
                        "description": "入住日期 YYYY-MM-DD"
                    },
                    "check_out_date": {
                        "type": "string",
                        "description": "离店日期 YYYY-MM-DD"
                    },
                    "guest_name": {
                        "type": "string",
                        "description": "入住客人姓名"
                    },
                    "guest_phone": {
                        "type": "string",
                        "description": "客人联系电话"
                    },
                    "guest_count": {
                        "type": "integer",
                        "description": "入住总人数",
                        "default": 2
                    },
                    "special_requests": {
                        "type": "string",
                        "description": "特殊要求（如高楼层、安静房间、加床等）",
                        "default": ""
                    }
                },
                "required": ["room_type", "check_in_date", "check_out_date", "guest_name", "guest_phone"]
            }
        ),
        types.Tool(
            name="query_order",
            description="根据订单号或客人手机号查询预订订单状态。",
            inputSchema={
                "type": "object",
                "properties": {
                    "order_id": {
                        "type": "string",
                        "description": "订单号，以WJ开头"
                    },
                    "phone": {
                        "type": "string",
                        "description": "预订时使用的手机号"
                    }
                }
            }
        ),
        types.Tool(
            name="cancel_reservation",
            description="取消酒店预订订单。会根据取消政策判断是否收取费用。",
            inputSchema={
                "type": "object",
                "properties": {
                    "order_id": {
                        "type": "string",
                        "description": "要取消的订单号"
                    },
                    "reason": {
                        "type": "string",
                        "description": "取消原因",
                        "default": ""
                    }
                },
                "required": ["order_id"]
            }
        ),

        # ==================== 天气查询 ====================
        types.Tool(
            name="get_nanjing_weather",
            description="查询南京未来3天的天气预报，包括温度、天气状况、降雨概率等，帮助客人规划行程和穿搭。",
            inputSchema={
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "查询日期，支持'今天'、'明天'、'后天'或具体日期YYYY-MM-DD"
                    }
                },
                "required": ["date"]
            }
        ),

        # ==================== 交通路线 ====================
        types.Tool(
            name="plan_travel_route",
            description="规划从酒店到目的地（或任意两点间）的交通路线，支持步行、驾车、公交、骑行四种方式。返回距离和预估用时。",
            inputSchema={
                "type": "object",
                "properties": {
                    "origin": {
                        "type": "string",
                        "description": "出发地名称，默认为酒店",
                        "default": HOTEL_NAME
                    },
                    "destination": {
                        "type": "string",
                        "description": "目的地名称，如：夫子庙、南京南站、禄口机场、南京博物院"
                    },
                    "mode": {
                        "type": "string",
                        "description": "出行方式：走路、驾车、公交、骑行",
                        "enum": ["走路", "驾车", "公交", "骑行"],
                        "default": "走路"
                    }
                },
                "required": ["destination"]
            }
        ),

        # ==================== 周边搜索 ====================
        types.Tool(
            name="search_nearby_poi",
            description="搜索酒店周边的餐厅、景点、商店、药店、ATM等设施。基于高德地图POI数据，返回名称、距离、评分、地址等信息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，如：餐厅、火锅、咖啡、药店、超市、ATM、景点"
                    },
                    "category": {
                        "type": "string",
                        "description": "POI类别（可选），如：餐饮服务、风景名胜、购物服务、医疗保健",
                        "default": ""
                    },
                    "radius": {
                        "type": "integer",
                        "description": "搜索半径（米），默认2000米",
                        "default": 2000
                    },
                    "count": {
                        "type": "integer",
                        "description": "返回结果数量，默认5个",
                        "default": 5
                    }
                },
                "required": ["keyword"]
            }
        ),

        # ==================== 服务工单 ====================
        types.Tool(
            name="create_service_ticket",
            description="创建酒店服务工单，用于记录客人的服务请求或投诉。工单会自动分派到相应部门处理。",
            inputSchema={
                "type": "object",
                "properties": {
                    "ticket_type": {
                        "type": "string",
                        "description": "工单类型",
                        "enum": ["客房服务", "设施报修", "投诉", "特殊需求", "礼宾服务"]
                    },
                    "priority": {
                        "type": "string",
                        "description": "优先级",
                        "enum": ["低", "中", "高", "紧急"],
                        "default": "中"
                    },
                    "description": {
                        "type": "string",
                        "description": "工单描述，详细说明客人的需求或问题"
                    },
                    "room_number": {
                        "type": "string",
                        "description": "客人房间号（如已入住）",
                        "default": ""
                    },
                    "guest_name": {
                        "type": "string",
                        "description": "客人姓名",
                        "default": ""
                    },
                    "guest_phone": {
                        "type": "string",
                        "description": "客人联系电话",
                        "default": ""
                    },
                    "conversation_summary": {
                        "type": "string",
                        "description": "AI客服与客人的对话摘要，便于工作人员了解上下文",
                        "default": ""
                    }
                },
                "required": ["ticket_type", "description"]
            }
        ),

        # ==================== 汉服体验预约 ====================
        types.Tool(
            name="book_hanfu_experience",
            description="预约酒店汉服体验服务。住客免费，非住客¥99/次。可选择汉服款式、体验日期和时间段。",
            inputSchema={
                "type": "object",
                "properties": {
                    "guest_name": {
                        "type": "string",
                        "description": "预约客人姓名"
                    },
                    "date": {
                        "type": "string",
                        "description": "体验日期 YYYY-MM-DD"
                    },
                    "time_slot": {
                        "type": "string",
                        "description": "时间段：上午(9:00-12:00)、下午(12:00-17:00)、傍晚(17:00-20:00)",
                        "enum": ["上午", "下午", "傍晚"],
                        "default": "下午"
                    },
                    "style_preference": {
                        "type": "string",
                        "description": "汉服风格偏好：齐胸襦裙、明制汉服、宋制褙子、直裰、圆领袍、儿童款",
                        "default": ""
                    },
                    "guest_count": {
                        "type": "integer",
                        "description": "体验人数",
                        "default": 1
                    },
                    "need_makeup": {
                        "type": "boolean",
                        "description": "是否需要妆发服务（¥50/人）",
                        "default": False
                    },
                    "is_hotel_guest": {
                        "type": "boolean",
                        "description": "是否为酒店住客（住客免费）",
                        "default": True
                    }
                },
                "required": ["guest_name", "date"]
            }
        ),

        # ==================== 酒店信息查询 ====================
        types.Tool(
            name="get_hotel_info",
            description="获取酒店的基本信息，包括地址、电话、设施列表、入住退房时间、儿童政策等。用于回答客人的通用咨询问题。",
            inputSchema={
                "type": "object",
                "properties": {
                    "info_type": {
                        "type": "string",
                        "description": "查询的信息类别",
                        "enum": [
                            "基本信息",
                            "入住退房政策",
                            "儿童政策",
                            "停车信息",
                            "早餐信息",
                            "设施列表",
                            "汉服体验",
                            "取消政策",
                            "全部"
                        ],
                        "default": "全部"
                    }
                }
            }
        ),

        # ==================== 人工客服转接 ====================
        types.Tool(
            name="transfer_to_human",
            description="将对话转接到人工客服。当AI无法解决客人问题、客人情绪激动、涉及退款赔偿、或客人主动要求时触发。",
            inputSchema={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "转接原因"
                    },
                    "priority": {
                        "type": "string",
                        "description": "紧急程度",
                        "enum": ["普通", "优先", "紧急"],
                        "default": "普通"
                    },
                    "department": {
                        "type": "string",
                        "description": "转接目标部门",
                        "enum": ["前台", "客服主管", "礼宾部", "客房部", "财务部"],
                        "default": "前台"
                    },
                    "conversation_summary": {
                        "type": "string",
                        "description": "对话摘要，方便人工客服接手",
                        "default": ""
                    },
                    "guest_emotion": {
                        "type": "string",
                        "description": "客人情绪状态",
                        "enum": ["平和", "轻度不满", "中度不满", "强烈不满"],
                        "default": "平和"
                    }
                },
                "required": ["reason"]
            }
        ),
    ]


# =====================================================================
#  3. MCP 工具实现
# =====================================================================

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    arguments = arguments or {}
    logger.info(f"Tool called: {name}, args: {json.dumps(arguments, ensure_ascii=False)}")

    try:
        # ==================== 房态查询 ====================
        if name == "check_room_availability":
            check_in = arguments.get("check_in_date", "")
            check_out = arguments.get("check_out_date", "")
            room_type = arguments.get("room_type", "")
            guest_count = arguments.get("guest_count", 2)
            has_children = arguments.get("has_children", False)

            # 计算入住天数
            nights = 1
            if check_in and check_out:
                try:
                    d1 = datetime.strptime(check_in, "%Y-%m-%d")
                    d2 = datetime.strptime(check_out, "%Y-%m-%d")
                    nights = max(1, (d2 - d1).days)
                except ValueError:
                    pass

            results = []
            target_rooms = {room_type: ROOM_DATABASE[room_type]} if room_type and room_type in ROOM_DATABASE else ROOM_DATABASE

            for rt_name, rt_info in target_rooms.items():
                # 人数筛选
                if guest_count > rt_info["max_guests"]:
                    continue

                inventory = get_room_inventory(rt_name, check_in)
                
                room_result = {
                    "room_type": rt_name,
                    "category": rt_info["category"],
                    "area": f"{rt_info['area']}㎡",
                    "bed_type": rt_info["bed_type"],
                    "price_per_night": f"¥{inventory['price']}",
                    "price_type": inventory["price_type"],
                    "total_price": f"¥{inventory['price'] * nights}（{nights}晚）",
                    "available": inventory["available"],
                    "remaining": inventory["remaining"],
                    "facilities": rt_info["facilities"],
                    "breakfast": rt_info["breakfast"],
                    "description": rt_info["description"],
                    "child_friendly": rt_info.get("child_friendly", False),
                    "extra_benefits": rt_info.get("extra_benefits", [])
                }
                results.append(room_result)

            # 如果有儿童，把亲子友好的房型排在前面
            if has_children:
                results.sort(key=lambda x: (not x["child_friendly"], not x["available"]))
            else:
                results.sort(key=lambda x: not x["available"])

            output = {
                "hotel": HOTEL_NAME,
                "query_date": check_in,
                "check_out": check_out,
                "nights": nights,
                "available_rooms": results,
                "total_types_available": sum(1 for r in results if r["available"]),
                "tips": []
            }

            if has_children:
                output["tips"].append("带小朋友出行，推荐亲子主题房（含儿童乐园）或复式Loft房（空间更大）")
                output["tips"].append("1.2m以下儿童早餐免费，婴儿床可免费预约")

            return [types.TextContent(type="text", text=json.dumps(output, ensure_ascii=False, indent=2))]

        # ==================== 创建预订 ====================
        elif name == "create_reservation":
            room_type = arguments.get("room_type", "")
            check_in = arguments.get("check_in_date", "")
            check_out = arguments.get("check_out_date", "")

            # 检查房态
            inventory = get_room_inventory(room_type, check_in)
            if not inventory.get("available"):
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": f"抱歉，{room_type} 在 {check_in} 已满房，建议更换日期或房型。"
                }, ensure_ascii=False))]

            # 计算价格
            nights = 1
            try:
                d1 = datetime.strptime(check_in, "%Y-%m-%d")
                d2 = datetime.strptime(check_out, "%Y-%m-%d")
                nights = max(1, (d2 - d1).days)
            except ValueError:
                pass

            order = create_order({
                "room_type": room_type,
                "check_in_date": check_in,
                "check_out_date": check_out,
                "nights": nights,
                "guest_name": arguments.get("guest_name", ""),
                "guest_phone": arguments.get("guest_phone", ""),
                "guest_count": arguments.get("guest_count", 2),
                "special_requests": arguments.get("special_requests", ""),
                "price_per_night": inventory["price"],
                "total_price": inventory["price"] * nights,
                "breakfast": ROOM_DATABASE.get(room_type, {}).get("breakfast", "")
            })

            result = {
                "success": True,
                "order": order,
                "reminders": [
                    f"入住时间：{check_in} 14:00后",
                    f"退房时间：{check_out} 12:00前",
                    "请携带身份证办理入住",
                    f"押金：¥500（支持信用卡预授权）",
                    "免费取消：入住前1天18:00前"
                ]
            }

            if ROOM_DATABASE.get(room_type, {}).get("child_friendly"):
                result["reminders"].append("温馨提示：酒店提供免费汉服体验，非常适合亲子打卡哦！")

            return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        # ==================== 查询订单 ====================
        elif name == "query_order":
            order_id = arguments.get("order_id", "")
            phone = arguments.get("phone", "")

            if order_id and order_id in ORDERS_DB:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": True,
                    "order": ORDERS_DB[order_id]
                }, ensure_ascii=False, indent=2))]

            if phone:
                matching = [o for o in ORDERS_DB.values() if o.get("guest_phone") == phone]
                if matching:
                    return [types.TextContent(type="text", text=json.dumps({
                        "success": True,
                        "orders": matching
                    }, ensure_ascii=False, indent=2))]

            return [types.TextContent(type="text", text=json.dumps({
                "success": False,
                "error": "未找到相关订单，请确认订单号或手机号是否正确。如需帮助请拨打前台电话。",
                "hotel_phone": HOTEL_PHONE
            }, ensure_ascii=False))]

        # ==================== 取消订单 ====================
        elif name == "cancel_reservation":
            order_id = arguments.get("order_id", "")
            reason = arguments.get("reason", "")

            if order_id not in ORDERS_DB:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": "未找到该订单"
                }, ensure_ascii=False))]

            order = ORDERS_DB[order_id]
            check_in = order.get("check_in_date", "")
            
            # 判断取消政策
            cancel_fee = 0
            cancel_note = ""
            try:
                check_in_dt = datetime.strptime(check_in, "%Y-%m-%d")
                deadline = check_in_dt - timedelta(hours=6)  # 入住前1天18:00
                now = datetime.now()
                
                if now < deadline:
                    cancel_fee = 0
                    cancel_note = "免费取消"
                else:
                    cancel_fee = order.get("price_per_night", 0)
                    cancel_note = f"已过免费取消时限，需收取首晚房费¥{cancel_fee}"
            except ValueError:
                cancel_note = "请联系前台确认取消费用"

            order["status"] = "已取消"
            order["cancel_reason"] = reason
            order["cancel_fee"] = cancel_fee

            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "order_id": order_id,
                "status": "已取消",
                "cancel_fee": cancel_fee,
                "cancel_note": cancel_note,
                "refund_note": "退款将在3-5个工作日内原路返回" if cancel_fee == 0 else f"扣除首晚房费¥{cancel_fee}后退还剩余款项"
            }, ensure_ascii=False, indent=2))]

        # ==================== 天气查询 ====================
        elif name == "get_nanjing_weather":
            date_input = arguments.get("date", "今天")
            
            # 解析日期
            today = datetime.now()
            if date_input == "今天":
                target_date = today
                day_index = 0
            elif date_input == "明天":
                target_date = today + timedelta(days=1)
                day_index = 1
            elif date_input == "后天":
                target_date = today + timedelta(days=2)
                day_index = 2
            else:
                try:
                    target_date = datetime.strptime(date_input, "%Y-%m-%d")
                    day_index = (target_date - today).days
                except ValueError:
                    target_date = today
                    day_index = 0

            # 调用和风天气 API（南京城区 location=101190101）
            # 生产环境使用真实API，这里做 fallback 处理
            weather_data = None
            if QWEATHER_KEY and QWEATHER_KEY != "your_qweather_key_here":
                try:
                    url = "https://devapi.qweather.com/v7/weather/3d"
                    params = {"location": "101190101", "key": QWEATHER_KEY}
                    res = requests.get(url, params=params, timeout=5).json()
                    if res.get("code") == "200" and res.get("daily"):
                        if day_index < len(res["daily"]):
                            d = res["daily"][day_index]
                            weather_data = {
                                "date": d["fxDate"],
                                "day_weather": d["textDay"],
                                "night_weather": d["textNight"],
                                "temp_max": f"{d['tempMax']}℃",
                                "temp_min": f"{d['tempMin']}℃",
                                "humidity": f"{d['humidity']}%",
                                "wind_dir": d["windDirDay"],
                                "wind_scale": d["windScaleDay"],
                                "uv_index": d.get("uvIndex", ""),
                                "precip": d.get("precip", "0")
                            }
                except Exception as e:
                    logger.warning(f"Weather API error: {e}")

            # Fallback：使用模拟数据
            if not weather_data:
                weather_data = {
                    "date": target_date.strftime("%Y-%m-%d"),
                    "day_weather": "多云",
                    "night_weather": "阴",
                    "temp_max": "22℃",
                    "temp_min": "14℃",
                    "humidity": "65%",
                    "wind_dir": "东南风",
                    "wind_scale": "3级",
                    "uv_index": "3",
                    "precip": "0",
                    "note": "（天气数据为模拟，实际请以当日为准）"
                }

            # 添加穿搭建议和活动建议
            temp_max = int(weather_data["temp_max"].replace("℃", ""))
            suggestions = {
                "clothing": "",
                "activity": [],
                "precautions": []
            }

            if temp_max >= 30:
                suggestions["clothing"] = "建议穿短袖、薄裙等夏季衣物，注意防晒"
            elif temp_max >= 20:
                suggestions["clothing"] = "建议穿薄外套或长袖，早晚温差较大"
            elif temp_max >= 10:
                suggestions["clothing"] = "建议穿厚外套或风衣，注意保暖"
            else:
                suggestions["clothing"] = "建议穿羽绒服或大衣，注意防寒"

            if "雨" in weather_data["day_weather"]:
                suggestions["precautions"].append("记得带伞，适合在酒店庭院品茶或室内活动")
                suggestions["activity"].append("酒店内庭院赏雨品茶")
                suggestions["activity"].append("室内VR体验")
            else:
                suggestions["activity"].append("汉服体验打卡老门东")
                suggestions["activity"].append("漫步夫子庙秦淮河畔")
                
            if "晴" in weather_data["day_weather"]:
                suggestions["activity"].append("庭院月洞门前拍汉服大片（14:00-16:00光线最佳）")
                suggestions["precautions"].append("紫外线较强，建议做好防晒")

            weather_data["suggestions"] = suggestions

            return [types.TextContent(type="text", text=json.dumps(weather_data, ensure_ascii=False, indent=2))]

        # ==================== 路线规划 ====================
        elif name == "plan_travel_route":
            origin = arguments.get("origin", HOTEL_NAME)
            destination = arguments.get("destination", "")
            mode = arguments.get("mode", "走路")

            # 地理编码
            origin_loc = amap_geocode(origin) if origin != HOTEL_NAME else HOTEL_LOCATION
            if origin == HOTEL_NAME:
                origin_loc = HOTEL_LOCATION
            else:
                origin_loc = amap_geocode(origin)
                
            dest_loc = amap_geocode(destination)

            if not origin_loc or not dest_loc:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": f"无法获取 {'出发地' if not origin_loc else '目的地'} 的位置信息，请尝试更具体的地址。"
                }, ensure_ascii=False))]

            # 根据出行方式调用不同的高德API
            mode_map = {
                "走路": ("v3/direction/walking", "route.paths"),
                "驾车": ("v3/direction/driving", "route.paths"),
                "公交": ("v3/direction/transit/integrated", "route.transits"),
                "骑行": ("v4/direction/bicycling", "data.paths")
            }

            api_path, result_path = mode_map.get(mode, mode_map["走路"])
            url = f"https://restapi.amap.com/{api_path}"
            params = {
                "origin": origin_loc,
                "destination": dest_loc,
                "key": AMAP_KEY
            }
            if mode == "公交":
                params["city"] = "南京"

            try:
                res = requests.get(url, params=params, timeout=8).json()
                
                # 提取路径数据
                path = None
                if mode == "骑行":
                    if res.get("errcode") == 0:
                        paths = res.get("data", {}).get("paths", [])
                        if paths:
                            path = paths[0]
                elif mode == "公交":
                    if res.get("status") == "1":
                        transits = res.get("route", {}).get("transits", [])
                        if transits:
                            path = transits[0]
                else:
                    if res.get("status") == "1":
                        paths = res.get("route", {}).get("paths", [])
                        if paths:
                            path = paths[0]

                if path:
                    distance = int(path.get("distance", 0))
                    duration = int(path.get("duration", 0))
                    
                    result = {
                        "success": True,
                        "origin": origin,
                        "destination": destination,
                        "mode": mode,
                        "distance": format_distance(distance),
                        "duration": format_duration(duration),
                        "tips": []
                    }

                    # 添加实用提示
                    if mode == "走路" and distance > 3000:
                        result["tips"].append(f"步行距离较远（{format_distance(distance)}），建议改为打车或公交")
                    if mode == "驾车":
                        result["tips"].append("酒店提供免费停车，但老门东景区周边节假日较拥堵")
                    if mode == "公交":
                        # 提取公交线路信息
                        segments = path.get("segments", [])
                        bus_lines = []
                        for seg in segments:
                            bus = seg.get("bus", {}).get("buslines", [])
                            for line in bus:
                                bus_lines.append(line.get("name", ""))
                        if bus_lines:
                            result["bus_lines"] = bus_lines[:3]

                    return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

            except Exception as e:
                logger.error(f"Route planning error: {e}")

            return [types.TextContent(type="text", text=json.dumps({
                "success": False,
                "error": f"未能找到合适的{mode}路线前往{destination}，建议拨打前台电话 {HOTEL_PHONE} 获取帮助。"
            }, ensure_ascii=False))]

        # ==================== 周边搜索 ====================
        elif name == "search_nearby_poi":
            keyword = arguments.get("keyword", "")
            category = arguments.get("category", "")
            radius = arguments.get("radius", 2000)
            count = arguments.get("count", 5)

            pois = amap_poi_search(
                keywords=keyword,
                types_code=category,
                radius=radius
            )

            if not pois:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": f"未找到酒店周边{radius}米内的「{keyword}」，请尝试扩大搜索范围或更换关键词。"
                }, ensure_ascii=False))]

            results = []
            for poi in pois[:count]:
                item = {
                    "name": poi.get("name", ""),
                    "type": poi.get("type", "").split(";")[0] if poi.get("type") else "",
                    "address": poi.get("address", ""),
                    "distance": f"{poi.get('distance', '')}米",
                    "tel": poi.get("tel", "") or "未公开",
                    "rating": poi.get("biz_ext", {}).get("rating", "") or "暂无评分",
                    "cost": poi.get("biz_ext", {}).get("cost", "") or ""
                }
                if item["cost"]:
                    item["cost"] = f"人均¥{item['cost']}"
                results.append(item)

            output = {
                "success": True,
                "keyword": keyword,
                "center": HOTEL_NAME,
                "radius": f"{radius}米",
                "results": results,
                "total_found": len(pois)
            }

            return [types.TextContent(type="text", text=json.dumps(output, ensure_ascii=False, indent=2))]

        # ==================== 创建服务工单 ====================
        elif name == "create_service_ticket":
            ticket = create_ticket({
                "type": arguments.get("ticket_type", ""),
                "priority": arguments.get("priority", "中"),
                "description": arguments.get("description", ""),
                "room_number": arguments.get("room_number", ""),
                "guest_name": arguments.get("guest_name", ""),
                "guest_phone": arguments.get("guest_phone", ""),
                "conversation_summary": arguments.get("conversation_summary", ""),
                "assigned_to": _get_department(arguments.get("ticket_type", ""))
            })

            # 预估处理时间
            priority_eta = {"低": "24小时", "中": "2小时", "高": "30分钟", "紧急": "15分钟"}
            eta = priority_eta.get(arguments.get("priority", "中"), "2小时")

            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "ticket": ticket,
                "estimated_response_time": eta,
                "message": f"工单已创建（{ticket['ticket_id']}），已分派到{ticket.get('assigned_to', '相关部门')}，预计{eta}内响应。",
                "hotel_phone": HOTEL_PHONE
            }, ensure_ascii=False, indent=2))]

        # ==================== 汉服体验预约 ====================
        elif name == "book_hanfu_experience":
            guest_name = arguments.get("guest_name", "")
            date = arguments.get("date", "")
            time_slot = arguments.get("time_slot", "下午")
            is_hotel_guest = arguments.get("is_hotel_guest", True)
            need_makeup = arguments.get("need_makeup", False)
            guest_count = arguments.get("guest_count", 1)

            # 计算费用
            hanfu_fee = 0 if is_hotel_guest else 99 * guest_count
            makeup_fee = 50 * guest_count if need_makeup else 0
            total_fee = hanfu_fee + makeup_fee

            time_map = {
                "上午": "09:00-12:00",
                "下午": "12:00-17:00",
                "傍晚": "17:00-20:00"
            }

            booking = {
                "booking_id": f"HF{datetime.now().strftime('%Y%m%d%H%M%S')}",
                "status": "已预约",
                "guest_name": guest_name,
                "date": date,
                "time_slot": f"{time_slot}（{time_map.get(time_slot, '')}）",
                "guest_count": guest_count,
                "style_preference": arguments.get("style_preference", "到店选择"),
                "need_makeup": need_makeup,
                "is_hotel_guest": is_hotel_guest,
                "fee_breakdown": {
                    "hanfu": f"¥{hanfu_fee}（{'住客免费' if is_hotel_guest else f'{guest_count}人×¥99'}）",
                    "makeup": f"¥{makeup_fee}" if need_makeup else "无",
                    "total": f"¥{total_fee}"
                }
            }

            tips = [
                f"请于{date}到酒店一楼前台领取汉服",
                "建议提前15分钟到达选择款式",
                f"请于当日20:00前归还汉服"
            ]

            if time_slot == "下午":
                tips.append("💡 下午14:00-16:00是拍照黄金时段，光线最柔和")
            
            tips.append("📸 推荐拍照地点：酒店庭院月洞门前、老门东箍桶巷、边营街")

            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "booking": booking,
                "tips": tips
            }, ensure_ascii=False, indent=2))]

        # ==================== 酒店信息查询 ====================
        elif name == "get_hotel_info":
            info_type = arguments.get("info_type", "全部")

            hotel_info = {
                "基本信息": {
                    "name": HOTEL_NAME,
                    "address": HOTEL_ADDRESS,
                    "phone": HOTEL_PHONE,
                    "opening_year": 2024,
                    "rating": "4.8/5.0（超棒，1074条评价）",
                    "style": "复古风·苏州园林式庭院",
                    "highlight": "窗外好景、智能客控、免费停车、儿童乐园、汉服体验",
                    "nearest_subway": "武定门地铁站（步行约800米，12分钟）"
                },
                "入住退房政策": {
                    "check_in_time": "14:00（可申请提前至12:00，视房态）",
                    "check_out_time": "12:00",
                    "late_check_out": {
                        "12:00-14:00": "免费（需提前申请，视房态）",
                        "14:00-18:00": "加收半天房费",
                        "18:00后": "加收全天房费"
                    },
                    "deposit": "¥500/间（支持信用卡预授权或现金）",
                    "required_documents": "身份证/护照/港澳通行证",
                    "front_desk": "24小时服务"
                },
                "儿童政策": {
                    "free_stay": "12岁以下儿童与成人同住不加收（使用现有床铺）",
                    "breakfast": {
                        "1.2m以下": "免费",
                        "1.2m以上": "按成人半价收费"
                    },
                    "extra_bed": "¥200/晚（含一份早餐）",
                    "baby_crib": "免费提供（限1张/间，需提前1天预约）",
                    "kids_club": "酒店设有儿童乐园，亲子主题房住客免费使用"
                },
                "停车信息": {
                    "parking": "免费停车",
                    "type": "酒店自有停车场",
                    "note": "老门东景区周边节假日较拥堵，建议错峰出行"
                },
                "早餐信息": {
                    "time": "07:00-10:00",
                    "type": "自助早餐",
                    "location": "酒店餐厅",
                    "price": "房费含早的房型免费；单独购买约¥88/人",
                    "child_policy": "1.2m以下儿童免费"
                },
                "设施列表": {
                    "in_room": ["智能客控系统", "55寸智能电视", "免费WiFi（≥100Mbps）", "迷你吧", "保险箱", "品牌洗浴用品"],
                    "public": ["儿童乐园", "健身房", "自助洗衣房", "小会议室", "庭院花园", "免费停车场"],
                    "services": ["管家服务", "汉服体验（住客免费）", "行李寄存", "叫车服务", "24小时前台"]
                },
                "汉服体验": {
                    "fee": "住客免费，非住客¥99/次",
                    "time": "09:00-20:00",
                    "pickup_location": "一楼前台",
                    "styles": "女款20+、男款10+、儿童款5+",
                    "accessories": "头饰、扇子、油纸伞等",
                    "optional_makeup": "¥50/人（需提前预约）",
                    "best_photo_spots": ["酒店庭院月洞门前", "回廊长廊", "老门东街区", "箍桶巷", "边营街"],
                    "best_time": "14:00-16:00光线最柔和"
                },
                "取消政策": {
                    "free_cancel": "入住日前1天18:00前可免费取消",
                    "late_cancel": "之后取消收取首晚房费",
                    "no_show": "未入住收取首晚全额房费",
                    "ota_note": "OTA渠道以各平台预订时显示的政策为准",
                    "special_rate": "特价房/促销房通常不可取消"
                }
            }

            if info_type == "全部":
                output = hotel_info
            elif info_type in hotel_info:
                output = {info_type: hotel_info[info_type]}
            else:
                output = hotel_info

            return [types.TextContent(type="text", text=json.dumps(output, ensure_ascii=False, indent=2))]

        # ==================== 转人工客服 ====================
        elif name == "transfer_to_human":
            reason = arguments.get("reason", "")
            priority = arguments.get("priority", "普通")
            department = arguments.get("department", "前台")
            summary = arguments.get("conversation_summary", "")
            emotion = arguments.get("guest_emotion", "平和")

            # 生产环境：这里应调用实际的客服系统API进行转接
            # 如：企业微信客服、美洽、网易七鱼等
            transfer_result = {
                "success": True,
                "transfer_id": f"TR{datetime.now().strftime('%Y%m%d%H%M%S')}",
                "department": department,
                "priority": priority,
                "estimated_wait": _get_wait_time(priority),
                "reason": reason,
                "conversation_summary": summary,
                "guest_emotion": emotion,
                "fallback_phone": HOTEL_PHONE,
                "message": f"已为您转接{department}{'（加急处理）' if priority in ['优先', '紧急'] else ''}，预计等待{_get_wait_time(priority)}。您也可直接拨打 {HOTEL_PHONE}。"
            }

            return [types.TextContent(type="text", text=json.dumps(transfer_result, ensure_ascii=False, indent=2))]

        # ==================== 未知工具 ====================
        else:
            raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        logger.error(f"Tool error [{name}]: {e}", exc_info=True)
        return [types.TextContent(type="text", text=json.dumps({
            "success": False,
            "error": f"处理请求时发生错误：{str(e)}",
            "fallback": f"建议拨打酒店前台 {HOTEL_PHONE} 获取人工帮助。"
        }, ensure_ascii=False))]


def _get_department(ticket_type: str) -> str:
    """根据工单类型分派部门"""
    mapping = {
        "客房服务": "客房部",
        "设施报修": "工程部",
        "投诉": "客服主管",
        "特殊需求": "礼宾部",
        "礼宾服务": "礼宾部"
    }
    return mapping.get(ticket_type, "前台")


def _get_wait_time(priority: str) -> str:
    """根据优先级返回预计等待时间"""
    mapping = {
        "普通": "5-10分钟",
        "优先": "3分钟内",
        "紧急": "1分钟内"
    }
    return mapping.get(priority, "5-10分钟")


# =====================================================================
#  4. SSE 传输层配置
# =====================================================================

sse = SseServerTransport("/messages")


async def handle_sse(request: Request):
    """建立 MCP SSE 长连接"""
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
    tools = await handle_list_tools()
    return JSONResponse({
        "status": "running",
        "server": "wenjing-hotel-mcp",
        "hotel": HOTEL_NAME,
        "version": "2.0.0",
        "endpoints": {
            "sse": "/sse",
            "messages": "/messages"
        },
        "tools_count": len(tools),
        "tools": [{"name": t.name, "description": t.description[:50] + "..."} for t in tools]
    })


# =====================================================================
#  5. 构建 Starlette 应用
# =====================================================================

app = Starlette(
    debug=os.environ.get("DEBUG", "false").lower() == "true",
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


# =====================================================================
#  6. 启动入口
# =====================================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9000))
    logger.info(f"Starting Wenjing Hotel MCP Server on port {port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port)
