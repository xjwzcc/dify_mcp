# 教师助手：FC 内部沙箱部署

来源：AgentDemo main / bca4125918a0f20e420254a3a6a3ab83f65b50ea；固定 Codex CLI 0.162.0 + Node Bridge + DeepSeek。按当前要求改为单个 `cc_dify_mcp` FC 内运行，无需独立 MySQL、常驻主机或 E2B 模板。

## 运行边界

- Node 课堂网关、Agent Python 控制服务、DeepSeek Bridge 和 OSS 持久化代理均为可信进程。Python 使用独立工作目录与打包依赖，避免课堂 MCP 的同名包覆盖依赖。
- 每次 attempt 创建 bubblewrap 沙箱：独立 user/mount/PID/network/IPC/UTS 命名空间，非 root 身份，清空环境变量、丢弃 capabilities，在 `/tmp/teacher-agent-sandboxes/<attempt>` 使用独立磁盘工作区。每个活跃沙箱使用不同宿主 UID，避免进程配额、资源采样相互混淆；仅挂载系统运行库、固定执行程序和自己的工作目录。
- FC 实测不允许嵌套 procfs，因此使用合成 `/proc`，其中仅提供指向固定 Codex 程序的 `/proc/self/exe` 符号链接，满足 Rust 的路径查询。保留 PID 和网络隔离，不挂载宿主 procfs。Codex 使用外层沙箱执行配置 `danger-full-access`；此参数仅在通过启动预检的 bubblewrap 内使用，不存在宿主直接执行 fallback。
- 沙箱只能通过该 attempt 的 Unix socket 访问固定的模型、事件、只读工具三个接口。代理固定注入当前 attempt 令牌，不接受任意目的地址。DeepSeek 密钥、OSS 密钥、教学签名密钥均不进入沙箱。
- 默认全局最多四个 attempt 并行，每个教师在每门课程最多两个不同会话并行、至多三个排队请求。同一会话逐轮执行，未回收完成的沙箱继续占用名额。创建沙箱使用有界线程池，慢启动不会阻塞其他教师。FC 推荐 2 vCPU / 4 GiB / 512 MiB 磁盘，单实例 HTTP 并发度保持 100；最大实例数仍为 1，数据库持久化保持单写者。
- 每个沙箱保留进程/描述符/单文件/地址空间/CPU 限制，独立宿主监测线程每 0.5 秒采样该 UID 的 RSS 与工作区文件体积，超过 512 MiB / 64 MiB 时终止本轮并等待教师处理。沙箱内 `/tmp` tmpfs 有独立 64 MiB 容量上限。采样保护不等同于独立 cgroup 硬配额；启动检查为课堂和控制服务保留内存/磁盘余量。

## FC 生命周期与数据

SSE 请求激活执行，只有有有效订阅的 execution 可以出队。连接断开或超时后关闭当前 attempt，保留已提交历史，显式继续生成新 attempt。实例重启将旧 attempt 标记为等待继续，过期令牌不能再提交结果。不会将 FC 请求结束后的后台调度当作可靠执行保证。

Agent 使用独立 SQLite 文件保存事务。请求受理、最终回答、取消和业务效果等权威状态，通过 Node OSS 代理确认加密不可变快照后才返回。生成中的文本和执行租约先写本地 SQLite，后台每秒尝试批量上传；复制快照只短暂持有数据库锁，上传在锁外进行。快照上传串行且按版本递增，旧快照不能覆盖已保存的新结果。写入结果不确定时停止 Agent 后续读写，重新启动从 OSS 恢复。实例突然退出时，尚未上传的草稿片段可能丢失，已标记“已保存”的完整回答不受此影响。OSS `teaching/v1/teacher-agent/` 下分别保存数据库快照与加密附件，不修改课堂 SQLite 表结构或课堂 OSS 日志。

继续要求 `OSS_SINGLE_WRITER=1`、FC 最大实例数为 1，发布前停止旧实例，避免并发写入。保留不可变日志，后续数据规模增长时需要设计离线压缩与保留策略。

## 环境变量

在现有 FC 环境变量基础上增加：

```dotenv
TEACHER_AGENT_MODE=fc-internal
ENABLE_TEACHER_CHAT=1
TEACHER_AGENT_MODEL=deepseek-flash
TEACHER_AGENT_REASONING_EFFORT=low
TEACHER_AGENT_MAX_ACTIVE=4
TEACHER_AGENT_MAX_PER_TEACHER=2
DEEPSEEK_API_KEY=<只在 FC 服务端配置，不提交源码>
```

内部三个签名密钥由每次启动生成，只在可信进程间传递。保留原 OSS 配置、加密密钥、课程配置和教师密码。回滚入口可设 `ENABLE_TEACHER_CHAT=0`；完全停止 Agent 可移除 `TEACHER_AGENT_MODE` 并重启，历史仍在 OSS。

## 流式、展示和回收优化

- 增量回复不再逐片等待 OSS 上传；SSE 使用变更通知唤醒。密钥脱敏仅保留可能匹配密钥前缀的尾部，普通短句可立即输出。
- FC 默认推理强度为 `low`，可通过 `TEACHER_AGENT_REASONING_EFFORT=high` 恢复较高推理预算。模型仍为 `deepseek-flash`。
- Markdown 使用本地打包的 Marked 与 DOMPurify，支持标题、列表、表格、引用、代码块与复制。原始 HTML 作为文本处理，禁止自动加载外部图片及执行脚本。流式渲染每 80 毫秒合并一次，长表格可横向滚动，桌面聊天框可展开。
- 浏览器依赖固定在 package-lock.json；运行 `npm ci --ignore-scripts` 和 `npm run vendor:teacher-chat` 可重建 vendor 文件，版本、SHA256 和许可证一并保留。
- 每轮使用独立沙箱，共享只读程序与系统运行库。成功、失败、取消后，生命周期循环处理完再等待 1 秒，清理进程、socket、工作区、监测线程和计时器。内部沙箱准备阶段预算 30 秒，执行阶段重新计算 180 秒截止时间，宿主在进程启动约 185 秒后独立强制终止。旧版错误地把 180 秒准备时间叠加进宿主计时器，本版已修正。控制进程重启后清理新旧专用根目录下合法 attempt 名称的残留，不跟随符号链接。
- 不保留闲置沙箱池。回收工作区不删除会话历史或 OSS 附件；下一轮根据 session ID 恢复已提交工作区、用户历史、最近六条已提交回复，再注入本轮页面上下文和附件。不同会话的 checkpoint、令牌、工作区互不共享。
- 内部 SSE 连接不再把排队时间算入固定 240/300 秒连接预算；客户端断开、授权失效或执行结束仍会关闭连接。运行时限由该 attempt 的独立计时器控制。

## 打包

`deploy/package.py --agent-runtime <目录>` 增加 Agent 源码、Bridge 锁定依赖和 Python 3.10 Linux wheel。运行目录必须含 `bin/codex`、`bin/bwrap`、`bin/rg`、`python/`。Codex 与 bubblewrap 取自 lockfile 中 Linux 平台包，下载后校验 SHA512 integrity。不打包任何 .env、凭据、数据库、测试用户文件。Python 依赖锁定清单见 `teacher-agent-fc-requirements.txt`；跨平台安装时必须包含 Python 3.10 需要的 exceptiongroup 和 greenlet。

本机部署凭据、测试记录与 ZIP 位于 Git 忽略的 `data/fc-agent-build/` 和 `data/fc-oss-deploy/`。不要将这些目录提交或公开。

## 验证记录（2026-10-26）

- FC 原生检查：Linux 4.19、Python 3.10.9；user/mount/PID/network 命名空间可用；合成 proc 模式隔离预检通过；Codex 0.162.0 版本检查通过；确认函数工作进程无 CAP_SYS_ADMIN（控制台终端权限更高），使用 FC 预挂载的 64 MiB tmpfs，启动校验文件系统类型与容量。
- 针对性 Python：`services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py services/teacher-agent/tests/test_teaching.py services/teacher-agent/tests/test_api.py`（11 passed）。兼容调整后另运行 `... -m pytest -q services/teacher-agent/tests/test_fc_internal.py`（4 passed）；工作区兼容调整后同一文件再次通过（5 passed）。
- 针对性 Node：`/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/oss-storage.test.cjs tests/teacher-agent-gateway.test.cjs tests/integration.test.cjs`（16 passed）；`.../node --test tests/teacher-agent-persistence.test.cjs`（1 passed）；`.../node --check server.cjs`。
- DeepSeek `/models`：200，存在 `deepseek-flash` 与 `deepseek-v4-pro`。真实对话已完成；多轮记住“蓝帆”；沙箱 Python 计算 1..100 得到 5050；CSV 产物下载成功；匿名访问 401、跨课程会话访问 404；停止旧实例重新部署后，OSS 恢复历史和附件成功。
- 最终 v7 新会话的前两轮均为 attempt 1 提交成功。Chrome 教师页面通过本地静态页面与线上 FC API 代理完成登录、恢复历史、发送第三轮消息、接收回复并显示“已保存”；回复正确记住“蓝帆”和 5050。截图在本地忽略目录 `data/fc-agent-build/teacher-chat-live.png`。
- 未运行全量测试。未覆盖长期压力/容量、多教师并发、所有移动端浏览器、文件上传和取消的完整浏览器操作路径、独立 FC Sandbox/E2B 和独立 MySQL 部署路径。

### 实际执行的针对性测试命令

以下命令均在仓库根目录执行。部分测试在修复后重复执行；列出最终结果，不将重复次数累加为测试数量。

```bash
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py services/teacher-agent/tests/test_teaching.py services/teacher-agent/tests/test_api.py
# 11 passed
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py
# 最后一次 5 passed（新增清理边界测试后）
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/oss-storage.test.cjs tests/teacher-agent-gateway.test.cjs tests/integration.test.cjs
# 16 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-agent-persistence.test.cjs
# 1 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test services/teacher-agent/bridge/test/provider.test.js
# 4 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-agent-gateway.test.cjs tests/dev-fc-proxy.test.cjs
# 8 passed
BRIDGE_DIR=/Users/bytedance/client_exp/dify_mcp/services/teacher-agent/bridge PATH=/private/tmp/node-v24.10.0-darwin-arm64/bin:$PATH services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_runner_integration.py services/teacher-agent/tests/test_sandbox.py::test_export_skips_links_and_configuration
# 2 passed；首次未设置 BRIDGE_DIR 时因测试启动目录失败，修正调用后通过
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --check server.cjs
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --check agent/chat-gateway.cjs
git diff --check
```

线上验收脚本使用本地私有配置，脚本和结果留在忽略目录；不将凭据或包含用户数据的记录提交源码。

```bash
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/smoke.cjs
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/acceptance.cjs --recovery
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/acceptance.cjs
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/acceptance.cjs --verify
```

## 上一版发布（v7）

- FC：cn-hangzhou / cc_dify_mcp，最终包 `teacher-chat-internal-v7.zip`（183284966 bytes）。
- SHA256：`4529e8c037f5e29ab473a106c62fbba539a0442707a6c347133252c03e8e6145`。
- 修复 DeepSeek 推理条目同时带明文与附加不透明字段时的工具后续调用：保留完整明文，移除其不支持的伴随字段；不透明历史缺少明文时继续拒绝。
- FC 默认域名的 API 可用，浏览器直接访问 HTML 受到限制。现有页面入口仍使用仓库 README 的本地 `dev:fc` 代理；公网网页需要可用的自定义域名。

## 流式优化发布（v8，2026-10-26）

- FC：cn-hangzhou / cc_dify_mcp，已发布并重新启用；`/healthz` 返回课堂四个服务与 Agent 均正常。
- 部署包：`teacher-chat-internal-v8.zip`，183451781 bytes；SHA256 `7397439541286f4968d8f50c961615b05d1621b3777025d8fdc962100b22c9f9`。ZIP CRC、源码一致性、重复条目及密钥排除检查通过；线上 JS/CSS 与本地文件逐字节一致。
- 同一条约 350 字的备课与排版问题，优化前后各一个样本，均在第一次 attempt 成功。回答长度存在模型生成差异；下表是验收观察，不是延迟 SLA。

| 指标 | v7 | v8 |
| --- | ---: | ---: |
| 首个文字到达 | 12.709 秒 | 14.015 秒 |
| 最后文字到达 | 36.896 秒 | 16.998 秒 |
| 完整请求结束 | 42.815 秒 | 22.810 秒 |
| 输出字符数 | 486 | 529 |
| 首末分片间平均输出速度 | 20.1 字符/秒 | 177.3 字符/秒 |

首字等待没有改善；持续输出约提升 8.8 倍，整轮耗时降低约 47%。首字还包含模型推理及可能的上下文文件读取，需要单独优化，不将它混入吐字速度收益。

- 线上任务完成后，专用沙箱目录条目数为 0，`/dev/shm` 可用 67108864 bytes（64 MiB 全部释放）。当时整个 FC cgroup 内存为 612680064 / 2147483648 bytes，约 584 MiB / 2 GiB；此为完成后取样，不是峰值测量。
- 重部署历史恢复、既有 CSV 下载、匿名 401 和跨课程 404 校验通过；取消使用独立验收会话，不触碰课堂数据。
- 线上取消返回 `CANCELLED`，随后页面内新一轮对话提交成功。实例终端确认最近三次执行分别为 `COMMITTED/CANCELLED/COMMITTED`，均 `cleaned=1`；沙箱目录及 socket 残留总数为 0。新回复执行中的内存取样约 697 MiB / 2 GiB（非峰值）。
- Chrome 实际发送、流式 Markdown 展示、历史渲染、展开面板和代码复制均验证成功。截图：本地忽略目录 `data/fc-agent-build/teacher-chat-v8.png`；清理证据：`teacher-chat-v8-cleanup.png`。

本轮实际执行的测试命令：

```bash
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py services/teacher-agent/tests/test_gateway.py services/teacher-agent/tests/test_teaching.py services/teacher-agent/tests/test_api.py
# 23 passed
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py
# 新增完整 FC Gateway 增量/最终持久化回归后，11 passed
BRIDGE_DIR=/Users/bytedance/client_exp/dify_mcp/services/teacher-agent/bridge PATH=/private/tmp/node-v24.10.0-darwin-arm64/bin:$PATH services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_runner_integration.py
# 1 passed，真实 CLI 的上游请求均携带 low 推理强度
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-chat-markdown.test.cjs tests/teacher-agent-stream.test.cjs tests/teacher-agent-gateway.test.cjs tests/dev-fc-proxy.test.cjs
# 首次前两类 4 passed，后两类受 listen EPERM 限制；按原范围授权回环端口后重跑如下
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-agent-gateway.test.cjs tests/dev-fc-proxy.test.cjs
# 8 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-chat-markdown.test.cjs tests/teacher-agent-stream.test.cjs
# 明确浏览器模块类型后，4 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/latency.cjs before
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/latency.cjs after
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/acceptance.cjs --recovery
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/acceptance.cjs --verify
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/cancel-check.cjs
```

未运行全量测试；未覆盖长时间压力、多教师负载、所有移动端浏览器、真实 185 秒强制超时和极限内存耗尽。后台 OSS 写失败、最终提交等待、过期快照不能覆盖新状态、分片密钥脱敏和脚本注入已做针对性回归。

## 并发执行发布（v9，2026-10-26）

- 已部署到 cn-hangzhou / cc_dify_mcp。包 `teacher-chat-internal-v9.zip`，8752 个文件、183452941 bytes，SHA256 `c2022a94c8b94aa05aff78ac4cf0a777cb75d5f2cfa11eff5604a50d5c182424`；ZIP CRC、重复条目、运行时代码一致性和凭据排除检查通过。
- 当前配置：2 vCPU / 4 GiB / 512 MiB 磁盘，HTTP 单实例并发 100，最大实例数 1；全局沙箱并行 4，每教师每课程并行 2。单实例约束用于 OSS 单写者，不代表仅能有一名教师在线。
- 发布前发现云端启动命令已恢复为旧 uvicorn 入口，环境变量仅剩三项，执行角色为空，接口返回 412。已从本地私有部署配置恢复 `/bin/bash /code/deploy/bootstrap`、原有环境变量及原执行角色 `FCForccHangzhouOssRole`，并应用本版并发配置；未确认该配置变化的来源。
- 真实验收使用两个已有教师账号，各自创建两个独立测试会话，观察到四个 execution 同时处于 RUNNING，均实际调用沙箱命令。取消其中一个后，其余三个正常 COMMITTED；各回复仅包含自己的测试代号。
- 随后在第一个会话发起新一轮，在新沙箱实际读取上一轮的 `outputs/concurrency.txt`，内容与前轮代号一致。会话历史与已提交文件随 session 恢复，不依赖上一轮进程或内存。
- 执行完成后实例终端检查：最近五次 attempt 均 `cleaned=1`，专用目录与 socket 残留均为 0；FC 内存取样 665616384 / 4294967296 bytes（约 635 MiB / 4 GiB，仅空闲取样，非峰值）。截图保留于本地忽略目录 `data/fc-agent-build/concurrency-cleanup.png`。
- 完全销毁旧实例再启用，确认仅一个新实例运行；`/healthz` 四个课堂服务及 Agent 均正常。重新登录两个教师账号后，四个会话状态、后续轮次历史与生成文件下载内容全部从 OSS 恢复成功。

本轮实际执行的针对性测试命令：

```bash
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py services/teacher-agent/tests/test_teaching.py services/teacher-agent/tests/test_service.py services/teacher-agent/tests/test_api.py
# 38 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --check server.cjs
/private/tmp/node-v24.10.0-darwin-arm64/bin/node --test tests/teacher-agent-gateway.test.cjs tests/teacher-agent-stream.test.cjs
# 2 passed
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/concurrency.cjs --login-only
# 发布前因上述云端启动配置返回 412；恢复配置后下述完整验收通过
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/concurrency.cjs
# 4 同时运行，1 取消、3 成功，后续轮次读取前轮文件成功
/private/tmp/node-v24.10.0-darwin-arm64/bin/node data/fc-agent-build/concurrency.cjs --recovery
# 冷启动后历史、状态和文件内容恢复通过
git diff --check
```

未运行全量测试；未覆盖长时间压力、大规模用户负载、所有浏览器、真实内存耗尽和持续 185 秒超时。内存/磁盘监测与超时计时器有针对性回归，但采样监测不是每个沙箱的 cgroup 硬隔离。本版仅支持单 FC 实例中的有界并发，横向多实例需要另行迁移持久化与调度设计。
