> 2026-10-26 实施修订：按用户最新要求改为现有 FC 内部 bubblewrap 沙箱，使用独立 OSS 加密持久化；下文独立 MySQL、常驻 Worker 与 E2B 为最初方案。当前实现与上线步骤见 [部署说明](../deploy/TEACHER-CHAT.md)。

# 教师端 Agent Chat 集成技术方案

本方案将 AgentDemo 的执行框架接入餐饮、酒店两个已登录教师页面。采用原生 JavaScript 聊天组件、Node.js 身份与业务适配层、独立 Python Agent 控制服务，以及 Codex CLI 和 DeepSeek 执行链路。首期交付多轮对话、真实教学数据查询、分析与草稿生成。

本文中的新增路径、接口、表字段和参数均为拟实施设计，尚未实现。当前课堂数据继续由原课程服务维护；Agent 的状态、工作区和文件独立存储。

## 1 源码基线与实施边界

2026 年 10 月 26 日通过 `git ls-remote` 核对 AgentDemo 的 `refs/heads/main`，提交为 `bca4125918a0f20e420254a3a6a3ab83f65b50ea`。本方案仅以该 main 分支提交为基线。

参考源码：

- [执行服务与 briefing](https://github.com/xjwzcc/agent_demo/blob/bca4125918a0f20e420254a3a6a3ab83f65b50ea/agent_demo/service.py)
- [Worker 与提交机制](https://github.com/xjwzcc/agent_demo/blob/bca4125918a0f20e420254a3a6a3ab83f65b50ea/agent_demo/worker.py)
- [Chat API](https://github.com/xjwzcc/agent_demo/blob/bca4125918a0f20e420254a3a6a3ab83f65b50ea/agent_demo/api.py)
- [协议 Bridge](https://github.com/xjwzcc/agent_demo/blob/bca4125918a0f20e420254a3a6a3ab83f65b50ea/bridge/provider.js)
- [验证范围](https://github.com/xjwzcc/agent_demo/blob/bca4125918a0f20e420254a3a6a3ab83f65b50ea/docs/validation.md)

当前项目相关入口：`server.cjs`、`apps/catering/server.cjs`、`apps/hotel/server.cjs`、`apps/hotel/learning.cjs`、`storage/database.cjs`、`scripts/dev-fc-proxy.cjs`。当前项目使用 Node.js 24、原生 HTTP 和 SQLite；远端模式通过 OSS 日志确认持久化。AgentDemo 需要 Python 3.11 以上、Node Bridge 和独立 runner，因此选择独立容器部署，避免与现有 Python MCP 环境混装。

首期范围：

- 餐饮与酒店教师端共用聊天组件，自动沿用各课程登录态。
- 多会话、多轮追问、流式输出、取消、刷新恢复、断线续传。
- 查询课程、学生、工单、提交与业务过程；生成教学分析和批阅草稿。
- 支持 TXT、CSV 附件和执行产物下载；其他文件格式暂不承诺解析能力。
- 首期教学工具全部只读。生成的工单、评语、指导意见在聊天中作为草稿展示。

直接发布工单、提交成绩、发送指导属于后续写操作扩展，需要业务侧幂等与可核实回执。本方案不把工作区原子提交等同于教学数据库的跨系统事务。

## 2 部署单元与调用边界

| 单元 | 技术与职责 | 持有的数据与凭据 |
| --- | --- | --- |
| 教师 Chat | 原生 JavaScript、CSS、自定义元素 | 页面状态、会话 ID；不持有模型或服务密钥 |
| Chat BFF | 当前 Node 网关内的独立模块 | 课程 Cookie 的短时转发、Agent 请求签名密钥 |
| 课程 Agent Adapter | 各课程服务内的短请求处理模块 | 使用本课程数据库、身份与既有业务规则 |
| Agent Control | Demo FastAPI 服务和本地 Node Bridge | Agent SQL、文件存储、模型密钥、工具请求签名密钥 |
| Agent Worker | 领取、创建、续租、提交与清理 | Agent SQL、文件存储、沙箱管理凭据 |
| Runner | 独立 Docker 或 FC Agent Sandbox | 本次工作区和短期 attempt token |

浏览器请求链路为：教师 Chat → 同源 BFF → Agent Control。模型链路为：Runner 中的 Codex → Model Gateway → Node Bridge → DeepSeek。教学工具链路为：Codex MCP stdio → Tool Broker → 教学网关受鉴权入口 → 课程 Adapter。

Runner 不挂载教学数据库、宿主项目目录或 Docker socket；模型密钥不进入浏览器与 runner。原 Python MCP 的 `/sse` 和 `/messages` 保持原用途，首期教学查询使用专用 Adapter，避免将不相关的旧工具能力引入教师 Chat。

生产默认选择：现有教学 FC 保持单写部署；Agent Control 与 Worker 运行在独立常驻容器服务；执行端使用 FC Agent Sandbox；状态使用独立 MySQL 数据库；文件使用私有 OSS 的独立前缀。常驻容器可由已有容器主机承载，具体资源是否已有需要部署时核实。

本地开发选择：独立 Compose 启动 Control、Worker 和 Docker runner，Agent SQLite 与文件放在本地持久卷。接入本地临时课堂数据库，不默认通过 `dev:fc` 操作线上课堂。

## 3 源码引入与文件职责

将 main 基线源码作为独立服务目录纳入仓库，并记录来源提交。构建时使用固定源码与锁文件，不在启动时拉取浮动 main。后续同步 main 时逐项审查差异。

```text
docs/teacher-agent-technical-design.md
shared/teacher-chat/
  chat.js                         # 自定义元素、视图与交互
  api.js                          # 请求、幂等 ID、SSE 解析与续传
  state.js                        # 会话和执行状态管理
  chat.css                        # 独立样式
agent/
  chat-gateway.cjs                 # 浏览器 Chat 路由
  identity.cjs                     # 身份查询、签名与作用域
  tool-gateway.cjs                 # Agent 到教学系统的工具入口
apps/catering/agent-adapter.cjs
apps/hotel/agent-adapter.cjs
services/teacher-agent/
  UPSTREAM.md                     # main 来源、提交、改动说明
  agent_demo/                     # 保留 Demo 包名与核心模块
    teaching_auth.py              # 新增可信身份解析
    teaching_tools.py             # 新增教学工具适配
    migrations/                  # 新增版本化数据库迁移
  bridge/                         # 保留 provider 与协议边界
  sandbox_runtime/                # 保留固定 CLI 与 runner
  config/
    capabilities.json
    skills/teacher-assistant/SKILL.md
    skills/catering-teaching/SKILL.md
    skills/hotel-teaching/SKILL.md
  deploy/
  tests/
```

修改 `server.cjs` 时，在现有课程转发前匹配 Chat 白名单路由；正常课程请求继续进入原服务。Agent 故障不纳入现有平台启动的强依赖，单独提供 readiness 接口，避免模型服务不可用导致课堂整体无法启动。

`deploy/package.py` 只增加 BFF、共享前端和课程 Adapter 到教学部署包；Python Agent、Bridge、runner 独立构建。同步修改 `scripts/dev-fc-proxy.cjs` 的静态资源映射，Chat API 仍按课程路径转发。

## 4 身份与授权协议

### 4.1 浏览器到 BFF

对外路径保留课程前缀：`/catering/api/chat/*` 与 `/hotel/api/chat/*`。这是因为现有 Cookie 分别限制在 `/catering/` 与 `/hotel/`，不能直接改成根路径 `/api/chat` 并假设 Cookie 仍会发送。

每次 Chat 请求先校验方法、同源条件、请求大小，再调用课程服务内部接口：

```http
POST /{course}/api/agent-bridge
X-Agent-Bridge: <仅本机网关与课程服务持有的启动期密钥>
Cookie: <只转发当前课程 Cookie>

{"action":"identity"}
```

内部接口只允许回环来源和正确密钥；主网关与开发代理均禁止浏览器直达。它复用课程服务已有会话查询，返回 `teacher_id`、`role`、`course`、会话到期时间和 `login_ref`。学生返回 403，未登录返回 401。

`login_ref` 为课程原始会话 token 的 SHA256，只用于授权关联，不能独立作为凭据使用。酒店可匹配已有 token hash；餐饮在指定教师的少量有效会话中计算 hash 比对，不将其原始 token 存入 Agent SQL。内部接口沿用现有存储队列执行短查询，不在事务内等待 Agent HTTP 请求。

### 4.2 BFF 到 Agent Control

新增签名身份协议，不将 Demo 的固定租户 API Key 发给教师浏览器，也不让教师共用固定 tenant。

签名载荷包含以下字段：

```json
{
  "v": 1,
  "kid": "teaching-to-agent-v1",
  "iss": "teaching-platform",
  "aud": "teacher-agent",
  "deployment_id": "<部署标识>",
  "sub": "<课程教师 ID>",
  "course": "hotel",
  "role": "teacher",
  "login_ref": "<会话 token 的 SHA256>",
  "login_expires_at": 0,
  "iat": 0,
  "exp": 0,
  "method": "POST",
  "path": "/api/chat/sessions/<id>/messages",
  "body_sha256": "<实际转发请求体字节摘要>"
}
```

以上时间字段为结构占位，实际使用 Unix 秒。有效期为 60 秒，最大时钟偏差 5 秒。`X-Teacher-Assertion` 的编码为 `base64url(payload_bytes).base64url(HMAC_SHA256(key, encoded_payload))`。接收方使用恒定时间比较对原始编码字符串验签，再校验版本、受众、时间窗、路径、方法和请求体摘要，避免两种语言重新序列化 JSON 造成签名差异。`path` 包含实际转发的完整路径与规范化查询串；签名之后不再改写请求。

BFF 丢弃浏览器传入的所有内部身份头，并重新生成签名。Agent 从已验证的 `deployment_id + course + sub` 派生固定 tenant，例如三项以 NUL 分隔后取 SHA256 hex，继续复用 Demo 的 tenant 校验。所有会话、事件、执行和文件都受该作用域约束。

生产教师 Chat 路由只接受此身份协议，关闭 Demo 静态页面与固定 `CHAT_API_KEYS` 的通用业务入口；管理端和 runner 仍使用各自独立的管理凭据与 attempt token，不能与教师请求凭据混用。

请求签名允许有效期内的相同请求重送；业务幂等由 `request_id` 保证。不同正文复用 ID 返回 409。创建会话也增加请求 ID，避免断线重试创建重复会话。

### 4.3 工具调用与授权失效

新增 `kind=teaching` 工具适配。`Service.tool_call()` 验证 attempt 与工具白名单后，把数据库中冻结的教师上下文传给 `invoke_tool()`；身份不能来自模型的工具参数。

Agent 使用另一把方向独立的密钥签名请求：

```http
POST /internal/teacher-agent/tools
X-Agent-Tool-Assertion: <绑定请求体、路径、有效期的签名>

{
  "execution_id":"<id>",
  "attempt_id":"<id>",
  "teacher_id":"<id>",
  "course":"hotel",
  "login_ref":"<hash>",
  "tool":"get_student_detail",
  "arguments":{"student_id":"<id>"}
}
```

教学网关验签后仅转发到固定课程服务。Adapter 再验证会话仍有效、角色仍为教师、目标记录属于当前课程和允许范围。工具参数不包含 URL、SQL 或任意执行命令。

当前系统尚无教师与授课班级绑定关系。首期保持现有“教师可管理本课程”的业务权限，不能声称已经实现按授课关系隔离。聊天历史按具体教师与课程隔离。旧共享账号 `teacher` 对应一个共同身份；需要个人历史时使用现有统一账号中心提供的独立教师账号。

退出后新 Chat 请求立即拒绝。BFF 对长 SSE 每 15 秒复查登录态；Worker 对 PREPARING 和 RUNNING 执行的业务授权使用最长 5 秒有效的授权租约，续租失败则停止模型与工具访问并清理执行。授权检查独立于沙箱创建、inspect 和 `poll_until`，避免创建过程中租约无人续期；外部身份查询不占用数据库行锁。`lock_capability()` 同时检查 attempt 租约和业务授权租约。取消事件或退出通知可以加速撤销，但不作为唯一撤销依据。清理失败保持待清理状态，不能宣称沙箱已经销毁。

## 5 浏览器接口契约

下表路径均以 `/{course}/api/chat` 开头。浏览器仅使用 Cookie，不传 tenant、教师 ID、模型地址或 capability profile。

| 方法 | 路径 | 返回与语义 |
| --- | --- | --- |
| GET | `/capabilities` | 开关、支持的附件类型、大小和页面上下文能力 |
| POST | `/sessions` | `{request_id,title?}`；幂等创建并返回 session |
| GET | `/sessions?cursor=&limit=20` | 当前教师当前课程的会话列表、下一页 cursor |
| GET | `/sessions/{sid}/history?cursor=&limit=50` | 消息、状态、产物、证据引用与活动 execution |
| POST | `/sessions/{sid}/messages` | 持久化后返回 202、execution ID 和事件地址 |
| GET | `/executions/{eid}` | 当前状态、attempt、最终结果或可处理错误 |
| GET | `/executions/{eid}/events?after=N` | SSE，支持 Last-Event-ID |
| POST | `/executions/{eid}/cancel` | 幂等撤销执行并请求清理 |
| POST | `/executions/{eid}/resume` | 同 owner 明确恢复等待态并重新校验授权 |
| POST | `/sessions/{sid}/attachments?name=...` | 原始文件上传，返回 artifact ID |
| GET | `/artifacts/{aid}/download` | 校验归属后下载 |

发送消息的请求示例：

```json
{
  "request_id":"<浏览器生成并保留的 UUID>",
  "message":"分析这个班尚未提交招聘工单的学生，并给出辅导建议",
  "attachment_ids":[],
  "page_context":{
    "page":"reviews",
    "class_id":"<当前班级 ID>",
    "workorder_id":"<当前工单 ID>",
    "student_id":null
  }
}
```

`page_context` 是用户选择条件，不构成权限声明。BFF 和 Adapter 校验页面枚举、记录存在性、课程归属与相互关系。餐饮没有班级实体，收到非空 `class_id` 明确返回不支持，不伪造班级。

响应示例：

```json
{
  "session_id":"<sid>",
  "execution_id":"<eid>",
  "state":"QUEUED",
  "events_url":"/hotel/api/chat/executions/<eid>/events"
}
```

客户端在开始发送前创建并保存 `request_id` 和完整请求体。超时重发使用原请求；教师修改文本后发送才生成新 ID。幂等指纹包含文本、附件 ID、规范化页面选择与服务端能力版本，不包含短期签名时间、授权租约时间和查询时间。首次提交冻结上下文；相同请求的重送不能被新生成的时间戳误判为不同正文。

错误统一为 `{error:{code,message,retryable,request_id}}`。主要状态码：401 登录失效，403 非教师或权限不足，404 无权访问或不存在的资源，409 幂等正文冲突或状态冲突，413 输入超限，429 队列或额度上限，503 Agent 暂不可用。模型执行后的失败记录在 execution，不能把半段回答作为 HTTP 成功的最终结果。

## 6 Agent 数据模型

保留 Demo 现有的 `chat_session`、`chat_execution`、`chat_attempt`、`chat_event`、`chat_artifact`、`tool_operation`。以下变更只发生在独立 Agent 数据库。

| 对象 | 新增字段或表 | 用途 |
| --- | --- | --- |
| `chat_session` | `deployment_id`、`course`、`teacher_id`、`title`、`updated_at`、`create_request_id` | 会话归属、列表与创建幂等 |
| `chat_execution` | `page_context`、`auth_context`、`authorization_valid_until`、`capability_version` | 每轮冻结上下文与授权租约 |
| `chat_artifact` | `execution_id` 可空、`kind` | 区分上传与输出，刷新后恢复对应消息的产物 |
| `chat_tool_result` | ID、execution、attempt、tool、规范化参数、结果、摘要、查询时间、数据版本 | 保存只读工具的真实证据 |
| `chat_execution_context` | execution ID、上下文 JSON、版本 | 保存当前轮的对象引用和可供后续轮读取的上下文 |
| `agent_capacity_slot` | slot ID、attempt ID、状态、到期时间 | 控制全局沙箱数量；未确认清理前不释放占用 |
| `schema_version` | 版本与应用时间 | 显式迁移与升级校验 |

约束与索引：

- 保留 `UNIQUE(session_id, request_id)` 和事件序号唯一约束。
- 新增 `UNIQUE(tenant, create_request_id)`。
- 会话列表索引为 `(tenant, updated_at, id)`；执行历史为 `(session_id, created, id)`。
- 工具结果和上下文均绑定 execution 与 attempt；后续轮默认只读取 COMMITTED 执行的结果。
- 会话标题由首条用户消息确定性截取，首期不增加一次额外模型调用。
- JSON 字段大小受限；单次工具结果建议不超过 128 KiB，超过时分页或生成受控文件，不能静默截断并继续声称完整。

本项目课堂 OSS 模式的 `storage.ready()` 会拒绝未经离线迁移的表结构变化，因此首期不修改餐饮、酒店、账号数据库 schema。Agent 首次部署创建独立表；后续升级使用版本化 migration，不能把 `create_all()` 当作字段迁移。

## 7 教学工具与连续对话

工具定义由服务端配置，首期固定两个 profile：`teacher_catering_read` 和 `teacher_hotel_read`。BFF 依课程选择 profile 与 Skill；浏览器不能指定任意工具、Skill 或 MCP 地址。

| 工具 | 参数范围 | 数据来源与返回 |
| --- | --- | --- |
| `get_course_overview` | 酒店可选 class ID | 学生人数、工单数量、提交状态计数、更新时间 |
| `list_students_progress` | class ID、工单 ID、状态、cursor、limit | 学生、任务完成与提交情况；餐饮沿用其工单和业务记录口径 |
| `get_student_detail` | student ID、所需字段、日志分页 | 学生业务摘要、进度、必要操作记录 |
| `list_workorders` | 状态、对象、cursor、limit | 餐饮 tasks 或酒店 workorders 的规范化结果 |
| `get_submission_detail` | 工单 ID、student ID | 成果、业务证据、提交轮次、评分与反馈 |

查询逻辑在各课程 Adapter 内复用或抽取既有业务函数，不绕过服务直接读取另一个进程的 SQLite 文件，不把整个 snapshot 连同无关字段传给模型。成绩与人数由代码计算，模型解释结果。返回示例：

```json
{
  "evidence_id":"<服务端分配 ID>",
  "scope":{"course":"hotel","class_id":"<id>"},
  "retrieved_at":"<ISO 8601>",
  "source_version":{"revision":0},
  "data":{},
  "next_cursor":null
}
```

酒店可提供现有 revision 或学生 version；餐饮使用现有 state.version、提交时间与相关记录摘要。没有版本字段时返回查询时间和内容摘要，不伪造全局 revision。

Demo 目前的 briefing 包含全部用户消息、最近六条已提交回复以及外部写操作回执；它没有通用的只读查询证据持久化。集成时修改 `Service.briefing()`，加入冻结页面上下文、近期已提交轮次的工具证据和结构化对象引用。用户历史明确携带执行状态，避免将失败或取消的请求解释为已完成任务。

例如第一轮查询得到三名学生，第二轮问“他们卡在哪一步”：上下文保留对应 student ID、工单 ID、查询条件和时间；第二轮调用工具刷新三人的当前记录。旧回复仍标记为模型表述，不能当作数据事实。

每轮页面上下文独立冻结。教师切换页面不会改变正在运行的任务；下一条消息显示并使用新的页面选择。如果明确的本轮要求与历史范围冲突，以本轮要求为准；范围无法确定时由助手澄清。

教学 Skill 负责语言、教学任务、课程评分规则和证据使用要求。学生提交、附件和历史模型输出均作为资料处理，不能修改工具白名单。回答中的来源引用只解析服务端确实存在的 evidence ID，关联到当前教师有权查看的记录；不将模型提供的任意 URL 作为可信业务链接。

## 8 执行调度与原子提交

保留 Demo 的三个 ID：session 表示跨轮会话，execution 表示一条消息，attempt 表示一次实际沙箱尝试。继续使用 `codex exec --json`，不改为共享一个长期 CLI 进程，也不使用 `resume --last` 关联不同教师。

执行顺序：

1. BFF 完成身份、参数与上下文校验；Agent 事务写入消息和 QUEUED 事件，返回 202。
2. 调度器检查全局容量和教师并发额度，锁定会话，领取 execution，创建 attempt 与短期 token。
3. 恢复上次成功 checkpoint，生成本轮 briefing、Skill 快照及附件；创建独立 sandbox。
4. Codex 经 Gateway 调用 DeepSeek，通过 Tool Broker 查询教学数据。模型与工具请求均校验 attempt 和业务授权租约。
5. Gateway 记录临时文本事件；Tool Broker 保存有来源的查询结果；前端展示进行中状态。
6. CLI 正常结束后，Worker 验证输出、文件路径、大小、attempt 状态、租约和基础 revision；候选文件先写不可变 blob。
7. 在一个 SQL 事务中更新 checkpoint、会话 revision、最终回复、已提交上下文、产物记录及 `turn.completed` 事件。
8. 清理 sandbox，确认后释放执行占用与容量槽，再开始同会话的下一条消息。

工作区、最终答案和上下文的逻辑发布边界是第 7 步 SQL 事务。对象存储不参与分布式事务；事务失败留下的候选 blob 不进入授权下载列表，后续按引用关系回收。

Demo 当前 `Worker.tick()` 在同一循环中执行 reconcile、cleanup 和一次 start。沙箱创建较慢时会拖延已有任务续租，因此新增两种 Worker 工作模式：

- `reconcile`：每 2 秒扫描到期检查任务、续租与回收；对平台调用设置超时，并使用有界并发，单个卡住的沙箱不能拖住全队列。
- `dispatch`：独立领取与创建；初始全局 sandbox 上限 4、每教师同时运行 1 个、每教师最多 3 条待执行。容量槽在数据库中原子领取，不能只依赖进程内计数。

以上为初始可配置限额，不是已验证容量。默认保留每 attempt 300 秒、最多 3 次尝试；创建阶段另设有界超时。未知写结果仍沿用 Demo 的 WAITING_INPUT 机制，但首期不会开放教学写工具。

授权失效、上下文超限、配置变化等不可自动修复错误进入明确等待或终止状态；不做三次无意义的模型重试。取消先撤销 attempt 能力，再清理沙箱，迟到结果不得提交。SSE 断线不会取消执行。

## 9 SSE 与前端状态

保留 Demo 的 `execution_id`、`seq`、`attempt_id`、`type`、`payload` 事件结构。连接最长约 50 秒后主动轮转；客户端带最后一个已处理的 seq 重连。HTTP heartbeat 每 15 秒以内，代理禁用缓冲。若入口仍缓冲 SSE，使用 execution 状态轮询保证可用，并将实时流验收标为不通过。

| 事件 | 页面行为 |
| --- | --- |
| `turn.queued` | 显示排队 |
| `attempt.started` | 创建本次尝试的临时输出区 |
| `tool.started` / `tool.completed` | 显示查询或执行进度 |
| `assistant.delta` | 按 attempt、request、item 追加临时文本 |
| `turn.retrying` | 标记旧尝试已中断，不将新旧文本拼接 |
| `artifact.created` | 加入受鉴权下载入口 |
| `turn.completed` | 用已提交完整答案替换临时文本 |
| `turn.waiting` / `turn.failed` / `turn.cancelled` | 显示可处理状态，保留历史 |

`response.completed` 只代表一次模型响应完成，不能作为业务 execution 已提交的证据。公共 SSE 不输出原始推理内容、内部 token 或完整 shell 日志。

为减少流式 token 逐条落 SQL 的压力，Gateway 将相邻文本按约 100 毫秒或 1 KiB 合并为事件，终止前 flush；仍保证单调 seq 与来源去重。网络分块解析使用 TextDecoder 流式模式并保留未结束 frame，覆盖中文跨字节、CRLF、多 data 行和半帧情况。

前端采用 `<teacher-agent-chat>` 自定义元素，挂载在 `#app` 外并使用隔离样式。餐饮 `render()` 每 8 秒重绘 `#app`，不会销毁 Chat。酒店 render 扩展链只通知身份和页面上下文，不重建 Chat 实例。

组件生命周期：

- `mount({course, teacher})`：身份有效后创建一次。
- `setContext(...)`：更新下一轮可选择的页面范围。
- `restore()`：加载会话、已提交消息与活动执行，再订阅事件。
- `destroy()`：退出或切换账号时终止 fetch、清空内存与身份相关界面。

聊天正文保存在服务器。浏览器只保存按教师与课程命名空间隔离的最后会话 ID，以及必要的待确认发送请求；默认使用 sessionStorage，退出时删除。输入区域支持中文输入法，composition 期间的 Enter 不触发发送。消息先按纯文本安全渲染；如增加 Markdown，仅启用白名单渲染且禁止原始 HTML。

## 10 存储与运行配置

Agent 数据库生产使用 MySQL 8，沿用 SQLAlchemy 与 READ COMMITTED、会话行锁。教学 SQLite 和 OSS 日志不承担 Agent 队列、租约或事件存储。

Demo 原 `Blobs` 只提供本地文件和 S3 接口，且直接使用 UUID 对象键。新增原生 OSS backend 与 `BLOB_PREFIX=teacher-agent/v1/blobs/`，保持 `{blob,sha256,size}` 引用格式；对象路径只由适配器构造。不能把现有 OSS endpoint 填进 S3 配置就视为已兼容。

教学平台新增配置：

```dotenv
ENABLE_TEACHER_CHAT=0
CHAT_TEACHER_ALLOWLIST=<试点教师与课程范围，正式放开时显式配置>
AGENT_BASE_URL=<Agent Control 内网或受保护 HTTPS 地址>
AGENT_SIGNING_KEY=<教学网关到 Agent 的签名密钥>
AGENT_TOOL_VERIFY_KEY=<验证 Agent 工具请求的独立密钥>
TEACHING_DEPLOYMENT_ID=<稳定部署标识>
```

Agent 新增或明确配置：

```dotenv
TEACHING_GATEWAY_URL=<教学网关受保护地址>
TEACHING_AUTH_VERIFY_KEY=<验证教学身份的密钥>
TEACHING_TOOL_SIGNING_KEY=<签名教学工具请求的独立密钥>
DATABASE_URL=<独立 Agent MySQL>
BLOB_BACKEND=oss
BLOB_PREFIX=teacher-agent/v1/blobs/
SANDBOX_PROVIDER=fc
MODEL=deepseek-flash
AGENT_MAX_ACTIVE=4
TEACHER_MAX_ACTIVE=1
TEACHER_MAX_PENDING=3
```

模型、沙箱、OSS 的具体凭据继续通过受控配置注入。保留 Demo 的固定 Codex CLI 0.162.0 作为初始联调版本；升级 CLI 独立验证 Bridge、模型目录和 MCP 行为。容器只注入对应服务需要的环境变量。

生产常驻 Worker 直接使用 SQL 持久队列领取任务，不依赖每分钟 FC timer，也不把 Worker 放在 FC HTTP 返回后继续运行。若未来全部迁入 FC，应另行实现有界异步领取与可靠调度，再替换常驻 Worker；这不是首期部署前提。

状态观测记录 session、execution、attempt、耗时、模型用量、工具耗时、重试原因与清理状态。关注队列长度、授权续租失败、未清理沙箱、SSE 重连次数。模型 token 用量是计量依据，首期不在 UI 承诺未经校验的金额。

GC 仅清理确认未被 checkpoint、产物或其他活动记录引用的候选 blob，并留出创建中的安全窗口；不对整个 Agent 前缀设置会删除已提交工作区的短期生命周期规则。

## 11 分阶段实施与验收

| 阶段 | 改动 | 通过条件 |
| --- | --- | --- |
| A 执行链路 | 引入 main 基线、固定镜像和版本、真实模型配置 | 文本、时钟工具、生成文件、第二轮读取文件、取消和沙箱清理通过 |
| B 身份与接口 | BFF、内部身份桥、签名协议、会话列表和上下文表 | 教师免重复登录；学生拒绝；跨教师、跨课程访问拒绝；消息幂等 |
| C 教学对话 | 两套 Adapter、只读工具、Skill、证据上下文 | 回答匹配真实记录；连续追问保留对象；统计可核对；未知范围会澄清 |
| D 页面与恢复 | 共享 Chat、SSE、历史与附件 | 8 秒刷新不丢输入；网络中断无重复消息；页面刷新可恢复当前执行 |
| E 生产验收 | 常驻 Worker、FC Sandbox、MySQL、原生 OSS | 断网与重启恢复；授权撤销；无迟到提交；课堂保存与批阅不受影响 |

本地模拟测试覆盖接口和故障语义；真实 DeepSeek、容器隔离、FC 网络与 OSS/MySQL 行为必须单独联调。Demo main 的现有验证记录尚未覆盖这些真实环境，不能跳过阶段 A 和 E。

具体验收样例：

1. 酒店教师查询某班某工单未提交名单，人工对照现有教师页面逐条一致；再追问“他们卡在哪一步”，对象范围不漂移。
2. 餐饮教师分析指定学生成果，引用实际提交和业务证据，不生成不存在的班级信息。
3. 上传 CSV 后分析并生成文件，刷新和下一轮仍可读取已提交产物。
4. 同 request ID 重送返回同 execution；修改正文复用 ID 返回 409。
5. 两名独立教师互换 session、execution、artifact ID 均被拒绝；学生无法请求 Chat。
6. 流式输出中断并重连后无重复文本；重试 attempt 的旧输出不会混入最终答案。
7. 执行中退出登录后在规定授权检查窗口内停止访问；取消后模型迟到结果不能提交。
8. 创建一个慢沙箱时，其他活跃任务仍持续续租；Worker 重启后恢复任务并清理遗留资源。
9. Agent 服务关闭时，两套课程的登录、学生保存、教师批阅仍可正常使用。

实现完成后先查看 `git diff` 确定影响范围，再运行对应测试文件。拟新增 Node 测试为 `tests/teacher-agent-auth.test.cjs`、`tests/teacher-agent-gateway.test.cjs`、`tests/teacher-agent-tools.test.cjs` 和 `tests/teacher-agent-stream.test.cjs`；Python 对身份、上下文、调度改动新增独立模块。只有修改 Bridge 时才运行其协议测试。开发代理变化对应现有 `tests/dev-fc-proxy.test.cjs`。不运行无过滤全量测试。

## 12 发布与回退

先部署独立 Agent 数据库、存储、Control、Worker 与 runner，完成专用测试账号联调；再部署教学 BFF 和前端资源，保持 `ENABLE_TEACHER_CHAT=0`。最后在测试教师范围启用，验证后逐步放开。

关闭开关后，停止接受新 Chat 执行，保留取消和查询能力处理已有任务；已有沙箱由 Worker 正常清理。界面移除新会话入口，课堂业务继续运行。必要时回退教学部署包；Agent 数据独立保留，数据库版本不支持的旧 Agent 代码不得强行启动。

本轮只新增本技术方案文档，未修改业务或框架代码。实际执行的测试命令：无。未覆盖范围：真实模型、Docker 和 FC 沙箱、MySQL 与 OSS 联调、浏览器交互、并发性能及生产部署。
