# 南京老门东金陵文璟酒店 MCP Server - 外部服务与接口分析

## 一、外部服务依赖全景图

```
                     ┌─────────────────────────────────┐
                     │     Dify Chatflow 主应用          │
                     │     (意图分类 + 多Agent流程)       │
                     └──────────────┬──────────────────┘
                                    │ MCP SSE
                     ┌──────────────▼──────────────────┐
                     │     MCP Server (阿里云FC)         │
                     │     wenjing-hotel-mcp             │
                     └──────────────┬──────────────────┘
                                    │
         ┌──────────┬───────────┬───┴───┬──────────┬──────────┐
         │          │           │       │          │          │
    ┌────▼───┐ ┌───▼────┐ ┌───▼───┐ ┌─▼────┐ ┌──▼───┐ ┌───▼────┐
    │高德地图 │ │和风天气 │ │酒店PMS│ │工单系统│ │客服系统│ │OTA API │
    │  API   │ │  API   │ │ API  │ │ API  │ │ API  │ │(可选)  │
    └────────┘ └────────┘ └──────┘ └──────┘ └──────┘ └────────┘
```

## 二、9 个 MCP 工具与外部服务映射表

| # | MCP 工具名 | 功能 | 外部服务 | 当前状态 | 生产改造 |
|---|---|---|---|---|---|
| 1 | `check_room_availability` | 房态价格查询 | 酒店PMS系统 | ✅ Mock数据 | 对接PMS API |
| 2 | `create_reservation` | 创建预订订单 | 酒店PMS/OTA | ✅ Mock数据 | 对接PMS API |
| 3 | `query_order` | 查询订单状态 | 酒店PMS/OTA | ✅ Mock数据 | 对接PMS API |
| 4 | `cancel_reservation` | 取消预订订单 | 酒店PMS/OTA | ✅ Mock数据 | 对接PMS API |
| 5 | `get_nanjing_weather` | 天气预报查询 | 和风天气API | ⚠️ 需配Key | 填入API Key即可 |
| 6 | `plan_travel_route` | 交通路线规划 | 高德地图API | ✅ 已实现 | 已可用 |
| 7 | `search_nearby_poi` | 周边POI搜索 | 高德地图API | 🆕 新增 | 已可用 |
| 8 | `create_service_ticket` | 创建服务工单 | 内部工单系统 | ✅ Mock数据 | 对接工单系统 |
| 9 | `book_hanfu_experience` | 汉服体验预约 | 内部预约系统 | 🆕 新增Mock | 对接预约系统 |
| 10 | `get_hotel_info` | 酒店信息查询 | 内置知识库 | ✅ 已实现 | 定期更新数据 |
| 11 | `transfer_to_human` | 转接人工客服 | 客服系统API | 🆕 新增Mock | 对接客服平台 |

## 三、各外部服务详细说明

### 3.1 高德地图 API（已实现 ✅）

**用途**：路线规划 + 周边POI搜索 + 地理编码

**调用的高德API接口**：

| 接口 | URL | 用途 | 对应工具 |
|---|---|---|---|
| 地理编码 | `restapi.amap.com/v3/geocode/geo` | 地址→坐标 | plan_travel_route |
| 步行路线 | `restapi.amap.com/v3/direction/walking` | 步行导航 | plan_travel_route |
| 驾车路线 | `restapi.amap.com/v3/direction/driving` | 驾车导航 | plan_travel_route |
| 公交路线 | `restapi.amap.com/v3/direction/transit/integrated` | 公交导航 | plan_travel_route |
| 骑行路线 | `restapi.amap.com/v4/direction/bicycling` | 骑行导航 | plan_travel_route |
| 周边搜索 | `restapi.amap.com/v3/place/around` | POI搜索 | search_nearby_poi |

**申请方式**：https://console.amap.com/dev/key/app
**费用**：个人开发者免费额度充足（5000次/日）
**环境变量**：`AMAP_KEY`

### 3.2 和风天气 API（需配置 Key ⚠️）

**用途**：南京3天天气预报

**调用接口**：

| 接口 | URL | 用途 |
|---|---|---|
| 3天预报 | `devapi.qweather.com/v7/weather/3d` | 天气预报 |

**申请方式**：https://dev.qweather.com/
**费用**：免费订阅计划支持1000次/日
**环境变量**：`QWEATHER_KEY`
**南京Location ID**：`101190101`

### 3.3 酒店 PMS 系统（Mock → 待对接）

**用途**：房态管理、价格管理、订单管理

**需要对接的接口**：

| 接口 | 方法 | 功能 | 对应工具 |
|---|---|---|---|
| `/rooms/availability` | GET | 查询房态库存 | check_room_availability |
| `/rooms/price` | GET | 查询实时价格 | check_room_availability |
| `/reservations` | POST | 创建预订 | create_reservation |
| `/reservations/{id}` | GET | 查询订单 | query_order |
| `/reservations/{id}` | PUT | 修改订单 | 待开发 |
| `/reservations/{id}/cancel` | POST | 取消订单 | cancel_reservation |

**常见PMS系统**：
- 绿云PMS、住哲PMS、别样红PMS（国内酒店常用）
- Opera PMS（国际品牌酒店）
- 自建系统

**对接方式**：
```python
# 将 Mock 替换为实际 API 调用
async def get_real_room_inventory(room_type, date):
    url = f"{HOTEL_API_BASE}/rooms/availability"
    headers = {"Authorization": f"Bearer {HOTEL_API_TOKEN}"}
    params = {"room_type": room_type, "date": date}
    res = requests.get(url, headers=headers, params=params, timeout=5)
    return res.json()
```

### 3.4 内部工单系统（Mock → 待对接）

**用途**：投诉处理、客房服务、设施报修

**需要对接的接口**：

| 接口 | 功能 | 对应工具 |
|---|---|---|
| 创建工单 | 新建服务/投诉工单 | create_service_ticket |
| 查询工单 | 查询处理进度 | 待开发 |
| 更新工单 | 处理完成回调 | 待开发 |

**可选方案**：
- 飞书多维表格（简单场景，快速搭建）
- 企业微信审批流
- 专业工单系统（Zendesk、美洽、网易七鱼）
- 自建轻量工单系统

### 3.5 客服系统（Mock → 待对接）

**用途**：AI无法处理时转接人工

**需要对接的API**：

| 功能 | 说明 | 对应工具 |
|---|---|---|
| 创建会话 | 将对话转移到人工坐席 | transfer_to_human |
| 传递上下文 | 携带对话摘要和情绪标签 | transfer_to_human |
| 坐席状态 | 查询是否有可用人工坐席 | transfer_to_human |

**可选方案**：
- 企业微信客服
- 美洽/网易七鱼
- 飞书服务台
- 自建在线客服

### 3.6 OTA 平台 API（可选扩展）

**用途**：同步携程/美团/飞猪等平台的订单

**可对接平台**：
- 携程开放平台
- 美团酒店开放平台
- 飞猪商家API

## 四、新增工具 vs 原有工具对比

### 你原有的3个工具：

| 原工具 | 改进点 |
|---|---|
| `check_room_availability` | ✅ 增加了多房型查询、亲子筛选、价格分类（平日/周末/节假日）、库存管理 |
| `get_nanjing_weather` | ✅ 从硬编码Mock改为调用和风天气API，增加穿搭建议和活动推荐 |
| `plan_travel_route` | ✅ 增加了公交线路提取、距离过远提醒、酒店停车提示等智能Tips |

### 新增的8个工具：

| 新工具 | 解决的场景 |
|---|---|
| `create_reservation` | 用户在对话中完成预订闭环 |
| `query_order` | 用户查询已有订单状态 |
| `cancel_reservation` | 用户取消订单（含政策判断） |
| `search_nearby_poi` | 推荐周边餐厅/景点/商店等 |
| `create_service_ticket` | 投诉处理和服务请求 |
| `book_hanfu_experience` | 汉服体验预约 |
| `get_hotel_info` | 酒店基本信息结构化查询 |
| `transfer_to_human` | 复杂问题转人工 |

## 五、Dify 中的 MCP 工具接入配置

### 5.1 在 Dify 中添加 MCP 工具

```
Dify 控制台 → 工具 → 添加自定义工具
    → 协议类型：MCP (SSE)
    → 服务地址：https://your-fc-function.cn-hangzhou.fc.aliyuncs.com/sse
    → 连接测试：确认能获取到 11 个工具列表
```

### 5.2 Chatflow 中工具调用节点配置

在各子流程的 LLM 节点中启用对应工具：

| 子流程 | 启用的 MCP 工具 |
|---|---|
| 预订流程 | check_room_availability, create_reservation |
| 咨询流程 | get_hotel_info, search_nearby_poi |
| 推荐流程 | search_nearby_poi, get_nanjing_weather, plan_travel_route |
| 体验流程 | book_hanfu_experience, get_hotel_info |
| 投诉流程 | create_service_ticket, transfer_to_human |
| 所有流程 | transfer_to_human（兜底） |

## 六、部署到阿里云 FC

### 6.1 目录结构

```
mcp_server/
├── app.py              # 主应用（MCP Server）
├── requirements.txt    # Python 依赖
├── .env.example        # 环境变量模板
└── Dockerfile          # 容器部署（可选）
```

### 6.2 阿里云 FC 部署步骤

```bash
# 1. 安装 Serverless Devs
npm install -g @serverless-devs/s

# 2. 配置 s.yaml
# 3. 部署
s deploy

# 4. 获取函数 URL
# https://xxx.cn-hangzhou.fc.aliyuncs.com
```

### 6.3 环境变量配置

在阿里云 FC 控制台设置以下环境变量：

| 变量名 | 值 | 说明 |
|---|---|---|
| AMAP_KEY | 你的高德Key | 路线+POI |
| QWEATHER_KEY | 你的和风Key | 天气 |
| HOTEL_API_BASE | PMS接口地址 | 酒店系统 |
| HOTEL_API_TOKEN | PMS Token | 酒店系统 |
| PORT | 9000 | FC默认端口 |

## 七、下一步优化建议

### 优先级 P0（立即）
1. ✅ 配置高德地图 API Key（路线+POI 已可用）
2. ⬜ 申请和风天气 API Key 并配置
3. ⬜ 部署到阿里云 FC 并测试

### 优先级 P1（1-2周）
4. ⬜ 对接酒店 PMS 系统，替换 Mock 房态数据
5. ⬜ 搭建轻量工单系统（飞书多维表格即可）
6. ⬜ 配置人工转接通道

### 优先级 P2（1个月）
7. ⬜ 对接 OTA 平台订单同步
8. ⬜ 增加用户画像存储（Redis/数据库）
9. ⬜ 增加对话日志采集和分析
10. ⬜ 增加 MCP Resource（酒店图片、PDF手册等静态资源）
