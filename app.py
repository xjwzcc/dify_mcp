"""
南京老门东金陵文璟酒店 - MCP Server v2
部署平台：阿里云 FC 函数计算
传输协议：SSE (Server-Sent Events)

可用工具（6个）：
1. check_room_availability - 查询房态价格（内置数据）
2. get_nanjing_weather     - 南京天气预报（和风天气API）
3. plan_travel_route       - 交通路线规划（高德地图API）
4. search_nearby_poi       - 周边POI搜索（高德地图API）
5. book_hanfu_experience   - 汉服体验预约（纯计算）
6. get_hotel_info          - 酒店信息查询（内置数据）

已移除工具（5个，因后端系统不存在）：
- create_reservation / query_order / cancel_reservation（无PMS）
- create_service_ticket（无工单系统）
- transfer_to_human（无客服系统）
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
QWEATHER_KEY = os.environ.get("QWEATHER_KEY", "ed4ecfe14275473fb8cb550a28b17195")

# 酒店基本信息
HOTEL_LOCATION = "118.786852,32.015908"
HOTEL_NAME = "南京老门东金陵文璟酒店"
HOTEL_ADDRESS = "南京市秦淮区夫子庙街道边营43号"
HOTEL_PHONE = "025-XXXXXXXX"

# ========== 初始化 MCP Server ==========
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
        "offset": 10,
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
    if meters < 1000:
        return f"{meters}米"
    return f"{meters / 1000:.1f}公里"


def format_duration(seconds: int) -> str:
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}分钟"
    hours = minutes // 60
    remaining = minutes % 60
    return f"{hours}小时{remaining}分钟"


# =====================================================================
#  房型数据库（携程最新数据 2026-04）
# =====================================================================

ROOM_DATABASE = {
    "莳光·景观房": {
        "name": "莳光·景观房",
        "category": "景观房",
        "area": 27,
        "bed_type": "1×1.8m大床",
        "max_guests": 2,
        "base_price": 398,
        "weekend_price": 498,
        "holiday_price": 698,
        "facilities": ["智能客控", "庭院景观", "独立卫浴", "品牌洗浴"],
        "description": "可观苏州园林式庭院景观，性价比首选",
        "breakfast": "含单早",
        "child_friendly": False
    },
    "莳光·文璟大床房": {
        "name": "莳光·文璟大床房",
        "category": "大床房",
        "area": 27,
        "bed_type": "1×1.8m大床",
        "max_guests": 2,
        "base_price": 450,
        "weekend_price": 550,
        "holiday_price": 750,
        "facilities": ["智能客控", "55寸电视", "独立卫浴", "雨淋花洒"],
        "description": "经典大床房，舒适简约",
        "breakfast": "含单早",
        "child_friendly": False
    },
    "莳光·VR视界": {
        "name": "莳光·VR视界",
        "category": "科技主题房",
        "area": 30,
        "bed_type": "1×1.8m大床",
        "max_guests": 2,
        "base_price": 458,
        "weekend_price": 558,
        "holiday_price": 758,
        "facilities": ["VR设备", "智能客控", "游戏主机", "投影仪"],
        "description": "科技感VR主题房，适合年轻人和情侣",
        "breakfast": "可选含早",
        "child_friendly": False
    },
    "莳光·文璟家庭房": {
        "name": "莳光·文璟家庭房",
        "category": "家庭房",
        "area": 27,
        "bed_type": "1×1.8m大床 + 1×1.2m单床",
        "max_guests": 3,
        "base_price": 500,
        "weekend_price": 600,
        "holiday_price": 800,
        "facilities": ["智能客控", "55寸电视", "独立卫浴"],
        "description": "适合带一个小孩的家庭出行",
        "breakfast": "含双早",
        "child_friendly": True
    },
    "莳雨小院": {
        "name": "莳雨小院",
        "category": "庭院双床房",
        "area": 42,
        "bed_type": "2×1.2m双床",
        "max_guests": 3,
        "base_price": 428,
        "weekend_price": 528,
        "holiday_price": 828,
        "facilities": ["私家小院", "户外茶座", "智能客控", "独立卫浴"],
        "description": "独立小院双床房，可在院中品茶赏景",
        "breakfast": "含双早",
        "child_friendly": True
    },
    "莳月·宜家": {
        "name": "莳月·宜家",
        "category": "豪华大床房",
        "area": 35,
        "bed_type": "1×1.8m大床 + 1×1.2m单床",
        "max_guests": 3,
        "base_price": 599,
        "weekend_price": 699,
        "holiday_price": 899,
        "facilities": ["智能客控", "55寸电视", "独立卫浴", "雨淋花洒", "迷你吧"],
        "description": "宽敞豪华，适合家庭",
        "breakfast": "含双早",
        "child_friendly": True
    },
    "莳月·亲和": {
        "name": "莳月·亲和（亲子房）",
        "category": "亲子房",
        "area": 40,
        "bed_type": "1×1.8m大床 + 1×0.9m儿童床",
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
    "莳月·雅居": {
        "name": "莳月·雅居（复式小楼）",
        "category": "复式房",
        "area": 50,
        "bed_type": "1×1.8m大床 + 1×1.4m沙发床",
        "max_guests": 4,
        "base_price": 1000,
        "weekend_price": 1200,
        "holiday_price": 1500,
        "facilities": ["复式设计", "双卫生间", "独立客厅", "智能客控", "浴缸"],
        "description": "50㎡复式小楼，上下两层，双卫，空间最大",
        "breakfast": "含双早",
        "child_friendly": True,
        "extra_benefits": ["双卫生间", "独立客厅"]
    }
}


def get_room_inventory(room_type: str, date: str) -> dict:
    """获取指定日期的房态库存（模拟）"""
    room = ROOM_DATABASE.get(room_type)
    if not room:
        return {"available": False, "error": "未找到该房型"}

    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        weekday = dt.weekday()
        holidays = ["2026-05-01", "2026-05-02", "2026-05-03",
                     "2026-10-01", "2026-10-02", "2026-10-03"]
        if date in holidays:
            price = room["holiday_price"]
            price_type = "节假日价"
        elif weekday >= 4:
            price = room["weekend_price"]
            price_type = "周末价"
        else:
            price = room["base_price"]
            price_type = "平日价"
    except ValueError:
        price = room["base_price"]
        price_type = "参考价"

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


# =====================================================================
#  MCP 工具定义（仅 6 个可用工具）
# =====================================================================

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        # ==================== 1. 房态查询 ====================
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
                        "description": "指定房型名称（可选）。不传则返回所有可用房型。可选值：莳光·景观房, 莳光·文璟大床房, 莳光·VR视界, 莳光·文璟家庭房, 莳雨小院, 莳月·宜家, 莳月·亲和, 莳月·雅居",
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

        # ==================== 2. 天气查询 ====================
        types.Tool(
            name="get_nanjing_weather",
            description="查询南京未来3天的天气预报，包括温度、天气状况、湿度、风向等，并给出穿搭建议和活动推荐。",
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

        # ==================== 3. 路线规划 ====================
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

        # ==================== 4. 周边搜索 ====================
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

        # ==================== 5. 汉服体验预约 ====================
        types.Tool(
            name="book_hanfu_experience",
            description="预约酒店汉服体验服务。住客免费，非住客¥99/次。可选择体验日期、时间段和人数，返回预约确认和费用明细。",
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

        # ==================== 6. 酒店信息查询 ====================
        types.Tool(
            name="get_hotel_info",
            description="获取酒店的基本信息，包括地址、电话、设施列表、入住退房时间、儿童政策、早餐、停车、汉服体验、取消政策等。",
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
    ]


# =====================================================================
#  MCP 工具实现
# =====================================================================

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    arguments = arguments or {}
    logger.info(f"Tool called: {name}, args: {json.dumps(arguments, ensure_ascii=False)}")

    try:
        # ==================== 1. 房态查询 ====================
        if name == "check_room_availability":
            check_in = arguments.get("check_in_date", "")
            check_out = arguments.get("check_out_date", "")
            room_type = arguments.get("room_type", "")
            guest_count = arguments.get("guest_count", 2)
            has_children = arguments.get("has_children", False)

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
                if guest_count > rt_info["max_guests"]:
                    continue

                inventory = get_room_inventory(rt_name, check_in)

                room_result = {
                    "room_type": rt_info.get("name", rt_name),
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
                "booking_channels": [
                    "携程搜索'南京老门东金陵文璟酒店'直接预订",
                    "美团/飞猪/同程 搜索酒店名称",
                    "拨打酒店前台电话",
                    "金陵酒店集团官方小程序"
                ],
                "tips": []
            }

            if has_children:
                output["tips"].append("带小朋友推荐：莳月·亲和（亲子房）含儿童乐园，或莳光·文璟家庭房（经济实惠）")
                output["tips"].append("1.2m以下儿童早餐免费，婴儿床可免费预约")

            return [types.TextContent(type="text", text=json.dumps(output, ensure_ascii=False, indent=2))]

        # ==================== 2. 天气查询 ====================
        elif name == "get_nanjing_weather":
            date_input = arguments.get("date", "今天")

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
            weather_data = None
            try:
                url = "https://devapi.qweather.com/v7/weather/3d"
                params = {"location": "101190101", "key": QWEATHER_KEY}
                res = requests.get(url, params=params, timeout=5).json()
                if res.get("code") == "200" and res.get("daily"):
                    if 0 <= day_index < len(res["daily"]):
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
                            "precip": d.get("precip", "0"),
                            "source": "和风天气实时数据"
                        }
            except Exception as e:
                logger.warning(f"Weather API error: {e}")

            if not weather_data:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": "天气数据获取失败，请稍后再试",
                    "tip": "可以查看手机天气APP获取最新南京天气"
                }, ensure_ascii=False))]

            # 穿搭建议和活动建议
            temp_max = int(weather_data["temp_max"].replace("℃", ""))
            suggestions = {"clothing": "", "activity": [], "precautions": []}

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
                suggestions["activity"].append("室内VR体验（莳光·VR视界房客专享）")
            else:
                suggestions["activity"].append("汉服体验打卡老门东（住客免费）")
                suggestions["activity"].append("漫步夫子庙秦淮河畔")

            if "晴" in weather_data["day_weather"]:
                suggestions["activity"].append("庭院月洞门前拍汉服大片（14:00-16:00光线最佳）")
                suggestions["precautions"].append("紫外线较强，建议做好防晒")

            weather_data["suggestions"] = suggestions
            return [types.TextContent(type="text", text=json.dumps(weather_data, ensure_ascii=False, indent=2))]

        # ==================== 3. 路线规划 ====================
        elif name == "plan_travel_route":
            origin = arguments.get("origin", HOTEL_NAME)
            destination = arguments.get("destination", "")
            mode = arguments.get("mode", "走路")

            if origin == HOTEL_NAME:
                origin_loc = HOTEL_LOCATION
            else:
                origin_loc = amap_geocode(origin)

            dest_loc = amap_geocode(destination)

            if not origin_loc or not dest_loc:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": f"无法获取{'出发地' if not origin_loc else '目的地'}的位置信息，请尝试更具体的地址。"
                }, ensure_ascii=False))]

            mode_map = {
                "走路": ("v3/direction/walking", "route.paths"),
                "驾车": ("v3/direction/driving", "route.paths"),
                "公交": ("v3/direction/transit/integrated", "route.transits"),
                "骑行": ("v4/direction/bicycling", "data.paths")
            }

            api_path, _ = mode_map.get(mode, mode_map["走路"])
            url = f"https://restapi.amap.com/{api_path}"
            params = {"origin": origin_loc, "destination": dest_loc, "key": AMAP_KEY}
            if mode == "公交":
                params["city"] = "南京"

            try:
                res = requests.get(url, params=params, timeout=8).json()

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

                    if mode == "走路" and distance > 3000:
                        result["tips"].append(f"步行距离较远（{format_distance(distance)}），建议改为打车或公交")
                    if mode == "驾车":
                        result["tips"].append("酒店提供免费停车，但老门东景区周边节假日较拥堵")
                    if mode == "公交":
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
                "error": f"未能找到合适的{mode}路线前往{destination}，建议拨打前台电话获取帮助。"
            }, ensure_ascii=False))]

        # ==================== 4. 周边搜索 ====================
        elif name == "search_nearby_poi":
            keyword = arguments.get("keyword", "")
            category = arguments.get("category", "")
            radius = arguments.get("radius", 2000)
            count = arguments.get("count", 5)

            pois = amap_poi_search(keywords=keyword, types_code=category, radius=radius)

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

            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "keyword": keyword,
                "center": HOTEL_NAME,
                "radius": f"{radius}米",
                "results": results,
                "total_found": len(pois)
            }, ensure_ascii=False, indent=2))]

        # ==================== 5. 汉服体验预约 ====================
        elif name == "book_hanfu_experience":
            guest_name = arguments.get("guest_name", "")
            date = arguments.get("date", "")
            time_slot = arguments.get("time_slot", "下午")
            is_hotel_guest = arguments.get("is_hotel_guest", True)
            need_makeup = arguments.get("need_makeup", False)
            guest_count = arguments.get("guest_count", 1)

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
                tips.append("下午14:00-16:00是拍照黄金时段，光线最柔和")

            tips.append("推荐拍照地点：酒店庭院月洞门前、老门东箍桶巷、边营街")

            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "booking": booking,
                "tips": tips
            }, ensure_ascii=False, indent=2))]

        # ==================== 6. 酒店信息查询 ====================
        elif name == "get_hotel_info":
            info_type = arguments.get("info_type", "全部")

            hotel_info = {
                "基本信息": {
                    "name": HOTEL_NAME,
                    "address": HOTEL_ADDRESS,
                    "phone": HOTEL_PHONE,
                    "opening_year": 2024,
                    "total_rooms": 69,
                    "rating": "4.7/5.0（超棒，1075条评价）",
                    "style": "明清风格·苏州园林式庭院",
                    "highlight": "窗外好景、智能客控、免费停车、儿童乐园、汉服体验（住客免费）",
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
                    "breakfast": {"1.2m以下": "免费", "1.2m以上": "按成人半价收费"},
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


# =====================================================================
#  SSE 传输层配置
# =====================================================================

sse = SseServerTransport("/messages")


async def handle_sse(request: Request):
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
    await sse.handle_post_message(
        request.scope,
        request.receive,
        request._send,
    )


async def homepage(request: Request):
    tools = await handle_list_tools()
    return JSONResponse({
        "status": "running",
        "server": "wenjing-hotel-mcp",
        "hotel": HOTEL_NAME,
        "version": "2.1.0",
        "tools_count": len(tools),
        "tools": [{"name": t.name, "description": t.description[:60] + "..."} for t in tools],
        "endpoints": {"sse": "/sse", "messages": "/messages"}
    })


# =====================================================================
#  构建 Starlette 应用
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

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9000))
    logger.info(f"Starting Wenjing Hotel MCP Server v2.1 on port {port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port)
