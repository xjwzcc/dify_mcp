# 设计与恢复语义

## 为什么保留 Bridge

Bridge 已经实现 Responses、Chat Completions、Anthropic 消息格式的路由、工具描述转换、流式事件转发和签名 scope。切换模型供应商只需要 provider 边界；重新写协议栈会增加工具、SSE、历史兼容问题。

`bridge/provider.js` 对 DeepSeek 做以下适配：使用配置的 `/responses` URL 和 Bearer key；不再发送 ModelHub 的 `extra.session_id`；将 Codex 的 developer 文本规则映射为 system；保留明文 reasoning 与 call_id 配对；拒绝不支持的不透明历史/工具。provider 明确不支持远程 compact。Bridge 保留的旧 ModelHub 分支不是本次验证目标。

原 Bridge 还做了几项必要的收敛：上游调用有超时和事件大小限制；截断流不再产生伪造 completed；DeepSeek 不存储进程内完整历史缓存；payload 日志默认关闭。历史以 Codex 提交的完整 input 为准，不依赖代理实例黏性。DeepSeek 模式下 GET response 和 previous_response_id 不可用于恢复。

## 三种 ID

| ID | 生命周期 | 作用 |
| --- | --- | --- |
| business session_id | 跨多轮、跨容器 | 持久业务会话与工作区版本 |
| execution_id | 一条用户消息 | request_id 去重、事件流和最终结果 |
| attempt_id | 一次实际尝试 | Codex thread、独立沙箱、短期 token、租约与 scope |

旧 ModelHub 的 session 是上游路由/资源作用域，不是业务会话数据库。DeepSeek 原生 Responses 为无状态接口，因此这里不需要映射一个持久 ModelHub session；attempt scope 仍参与 Bridge HMAC 鉴权。

## briefing_v1

1. 消息入库，冻结已授权 skill 文件及工具配置；返回 execution_id。
2. worker 锁住 session，保证同会话单写；记录 attempt、基础 revision 和配置摘要，再创建沙箱。
3. 恢复上一次**成功提交**的工作区，加上本轮附件、已授权 skill 快照、`context/briefing.json`。
4. briefing 包含全部用户请求、最近六条已提交助手回复（标记为 claim）、外部操作状态与回执。大于内联阈值时要求 Codex 分块读完整 briefing 文件。
5. 执行 `codex exec --json`。不调用 `resume`，不导入旧 `.codex`、加密 reasoning、旧 provider 的 resource ID。
6. 当前 attempt 内的后续模型请求、工具结果和本地上下文由 Codex 管理；每次模型请求经 Gateway 验证 attempt 并签名给原 Bridge。
7. CLI 成功、结果通过大小/路径校验、租约仍有效、基础 revision 未变化、没有未知写操作时，数据库事务原子更新工作区 head 和最终回复。
8. worker 销毁沙箱后释放 session，下条消息才启动。

新 thread 是本方案可恢复性/隔离的取舍，不是 DeepSeek 或 Codex 每一轮模型调用强制要求。CLI 一次 attempt 内不会每次模型请求都启动新进程。代价是重新注入 briefing 的 token 成本，以及旧推理轨迹不能原样延续；换来的是故障恢复不绑定某台 FC 实例或旧 provider session。

## 状态和失败

执行状态：QUEUED → RUNNING → COMMITTED；失败可到 RETRY_WAIT、WAITING_INPUT、FAILED；取消到 CANCELLED。

- `request_id` 在 session 下唯一。同一正文重发返回同 execution；正文不同报冲突。
- session 行锁串行化提交/事件。SQLite 使用 BEGIN IMMEDIATE；共享 SQL 使用 READ COMMITTED + FOR UPDATE，避免锁后读取旧快照。
- attempt token 数据库仅存 hash。每次模型/工具请求、每个上游事件都验证租约、attempt number、执行状态与配置摘要。
- 每个 bounded tick 续租/检查已有沙箱、清理完成实例，再最多领取一个新任务。HTTP SSE 断线不取消执行。
- 分配前持久化 intent；Docker 按确定名称、FC 按 metadata 找回资源。FC 额外有平台 TTL。取消分配中的任务先封锁 token，等待已发起的创建操作收敛再清理。
- 结果先写 immutable blob，再通过数据库事务切换 head。失败留下的候选 blob 不可被用户下载，但需要部署者周期回收；不能对所有对象设置会删除已提交内容的短期生命周期规则。
- Docker worker 停机期间不承诺即刻杀进程；runner 自有超时，调度恢复后清理。FC 定时触发同样需要监控，不能依赖 HTTP 返回后的后台线程继续运行。
- 工作区只承诺最后提交状态；失败 attempt 的未提交文件不会自动成为下一轮事实。

## 信任边界

控制层持有 DeepSeek key、SQL/OSS、FC 管理凭证和远端 MCP 凭证。沙箱只获得短期执行 token，不包含这些长期凭证，也不挂载 Docker socket 或宿主工作目录。

Docker backend 每个 attempt 分配独立 internal network，仅连接控制服务；非 root、只读镜像、cap-drop、no-new-privileges、内存/CPU/PID/文件数限制、临时工作区。Docker socket 只挂给可信 worker，拥有它意味着 worker 必须按基础设施控制服务保护。

FC backend 要求明确网关 IP/CIDR 白名单与已验收标记，禁止全网和 metadata 网段；具体限制由 FC 数据面执行。必须实测网关可达、公网和 metadata 不可达。管理 API 调用成功不等于网络隔离已生效。

工具权限来自静态 profile；runner 仅对快照内工具写入 Codex approval_mode=approve，后台非交互执行无需临时弹窗，未列出的工具仍不能调用。只读调用可以重试。写调用先落库 SENT，再访问外部 MCP；相同参数的已确认回执可复用，不确定请求不自动重放。不同参数/新 execution 也不能越过同 session 的未知写操作。`isError` 也会记作未知结果，因为失败可能发生在外部写入之后；只有人工核实未执行才记作 REJECTED。外部 MCP 必须如实声明效果。本 demo 不提供任意外部系统的全局 exactly-once 保证。

模型在沙箱内能看到执行 token，可能伪造本地文件或助手答复；这些不是外部业务成功证据。只有控制层工具回执与管理员核实记录能确认外部动作。代码不声称模型自身输出可信。

## 能力边界

短期上下文、shell/apply_patch、skill 执行与 MCP tool loop 交给 Codex。身份鉴别、长期状态、跨实例调度、外部工具凭证和权限不能交给模型自己管理。

当前 MCP 中继覆盖 tools，未覆盖 resources/prompts、交互式 OAuth 或审批表单。为扩展功能添加 server-side 工具适配和 profile 即可，无需重写 Bridge 或 CLI agent loop。
