# 本次验证记录

日期：2026-10-23。环境：macOS、Python3.11、Node22.22.3、固定 Codex CLI0.162.0。

先执行 `git diff --stat` 确定新增控制层、runner、Bridge provider、部署脚本和测试的影响范围；只运行相关模块/参数用例，没有运行无过滤的全量测试命令。

## 已执行的定向测试

以下为实际执行命令；重复用于修复回归的同名命令只列一次。运行时使用 Node22 的绝对路径，或在命令前设置对应 PATH；复现时将自己的 Node22 放入 PATH。

```bash
.venv/bin/python -m pytest tests/test_service.py tests/test_gateway.py tests/test_api.py tests/test_sandbox.py -q
node --test bridge/test/provider.test.js
.venv/bin/python -m pytest tests/test_bridge.py -q
.venv/bin/python -m pytest tests/test_cli_protocol.py -q
.venv/bin/python -m pytest tests/test_cli_protocol.py tests/test_bridge.py -q
.venv/bin/python -m pytest tests/test_service.py -k 'operator_resolution or unknown_write_fences' tests/test_sandbox.py -q
.venv/bin/python -m pytest tests/test_service.py -k 'mcp_write_is_error or empty_answer' -q
.venv/bin/python -m pytest tests/test_sandbox.py -q
.venv/bin/python -m pytest tests/test_service.py -k 'checkpoint_and_next_briefing or empty_answer' -q
.venv/bin/python -m pytest 'tests/test_cli_protocol.py::test_pinned_cli_model_catalog_and_responses[True]' -q
.venv/bin/python -m pytest tests/test_runner_integration.py -q
```

结果覆盖：Python26个独立用例（按各次定向运行合计去重）、Node3个用例。包括：

- 跨租户隔离、同 request_id 并发去重、同 session 单写、事件去重与 SSE cursor 重放。
- 工作区提交及下一轮重建、旧 skill 不残留、取消后阻止迟到提交、分配期间取消、过期 attempt 换 token。
- 请求预算、模型配置 fence、路径穿越、导出排除软/硬链接和保留目录。
- 外部写超时和 isError 都进入未知态；不能通过新 execution 绕过；核实前不能 resume。
- Docker 调用参数隔离约束、sticky tmpfs 文件归属；FC 不允许无验收/危险出网策略。
- 实际 Node Bridge HTTP/SSE：scope 签名、DeepSeek Bearer/envelope、429透传、流中断不伪造完成、incomplete、compact拒绝。
- 真实 CLI 读取模型目录、文本响应、调用 MCP stdio 并继续下一次模型请求。
- 真实 runner + CLI + Gateway + Bridge + Tool Broker + SQL 提交的本机完整协议链路。

其中第一个组合命令运行17例；后续新增函数/参数例均单独定向执行。带 `-k` 的命令会对其所有文件一起过滤，不能把 deselected 计为已测试。

## 发现与修复

- 初次本机 Bridge 测试因执行环境禁止监听端口失败；允许仅回环测试后通过。
- 初次 CLI 替身流缺少 output_item.done，导致 CLI 最终答案为空；完善合法 SSE 序列，并为 runner/提交增加空答案拒绝。
- 真实 MCP 循环最初被 CLI 的非交互审批策略拒绝；按授权快照生成逐工具 approval_mode 后，失败参数用例及完整 runner 链路通过。
- Docker cp 的文件归属可能阻止非root用户在 sticky tmpfs 中 rename；已增加可信 worker 的 chown 步骤，并验证调用序列。
- 本机 npm registry 重写导致下载失败；改用公开 registry 后固定 Codex 包安装成功。锁文件全部使用公开 npm 地址。

辅助检查：`git diff --check`；`python -m compileall -q agent_demo sandbox_runtime/main.py sandbox_runtime/mcp.py scripts deploy/fc/scheduler`；`node --check agent_demo/static/app.js`；固定 CLI `--version`。公开文件检查不包含真实 key、用户文件、原环境 `.env` 或内网服务地址。

## 未覆盖

- 未运行真实 DeepSeek API：没有提供可用于此次联调的 key，模型均为协议替身。
- 当前机器无 Docker 运行环境：未构建/运行实际容器，没有验证 Linux 内层沙箱、cgroup、网络数据面和跨容器销毁。
- 未部署阿里云资源：FC模板、E2B连接、OSS S3兼容、共享MySQL行锁、定时触发、SSE代理和网络规则需要云端验收。
- 未测试生产 MCP 服务、OAuth、外部系统 exactly-once 或人工核实真实性。
- 未运行浏览器自动化、压力测试、完整安全审计；未运行原 ModelHub/Anthropic/Chat Completions 兼容套件。
- 本机真实 CLI 测试只请求固定文本/时钟工具，没有执行模型生成的 shell 命令；它验证协议闭环，不能代替沙箱隔离验收。
