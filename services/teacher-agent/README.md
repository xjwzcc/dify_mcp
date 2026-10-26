> 当前目录是教学项目集成版。教师模式部署请使用 `../../deploy/TEACHER-CHAT.md` 和 `compose.teaching.yaml`；下方保留的上游 Demo 部署方式不是教师模式生产部署入口。

# Codex CLI + DeepSeek Sandbox Chat

复用现有 Node ModelHub Bridge，增加 DeepSeek provider 和独立的会话／沙箱控制层。提供可接入业务的 Chat HTTP API、SSE、附件与产物下载，以及一个简单的中文聊天页面。

**状态：可运行的参考实现，尚未通过真实 DeepSeek、Docker 或阿里云 FC 环境的端到端验收。** 定向测试使用替身模型和沙箱；Bridge 的 HTTP/SSE 测试启动真实 Node 服务。详见 [验证记录](docs/validation.md)。不要把替身测试通过等同于生产上线完成。

## 架构边界

```text
浏览器 / 业务调用方
        │ Bearer：租户 API key
        ▼
Chat API ── SQL（会话、执行、租约、事件、工具回执）
   │        Blob Store（本地 / S3 兼容 OSS）
   │
Worker / FC 定时调度器 ── 创建、轮询、销毁独立沙箱
                              │
                       Codex CLI + skill 文件
                              │ attempt capability
                 ┌────────────┴─────────────┐
                 ▼                          ▼
          Model Gateway                Tool Broker
                 │ signed scope            │ 允许的远端 MCP
          复用 Node Bridge                  │ 凭证留在控制层
                 │ DeepSeek provider       │
                 ▼                          ▼
           DeepSeek /responses          业务外部系统
```

- **复用**：`bridge/bridge.js`、`isolation.js`、`native-history.js` 的协议处理、工具转换和 scope 签名校验。不是重新实现一套 Bridge。
- **适配**：`bridge/provider.js` 替换 endpoint、Bearer 鉴权与 ModelHub session envelope；保留 ModelHub provider 分支，当前 Chat 服务启动器固定选择 DeepSeek。
- **新增**：持久业务会话、幂等请求、排队与租约、沙箱生命周期、工作区提交、事件重放、工具授权。这些能力不属于协议 Bridge。
- Codex 管理**一次 attempt 内**的模型历史、工具循环与本地工具执行。下一条业务消息、故障重试均通过 `briefing_v1` 重建一个新的 Codex thread。
- DeepSeek 使用原生 Responses 接口；本实现不提供旧版 Chat Completions-only 代理转换。需要供应商端确实支持 `/responses`、function/custom tool calls。

[完整设计与恢复语义](docs/architecture.md) · [API 与集成](docs/api.md) · [阿里云 FC 部署](deploy/fc/README.md)

## 本地运行

需要 Docker Engine / Docker Desktop 与 Compose、Python 3.11+。构建过程中需要访问公开 npm/PyPI 软件源。Node 22 和固定版本 Codex CLI 已放入容器镜像。

```bash
python3 scripts/configure.py
# 交互输入 DeepSeek key；自动生成租户 API key、Bridge 签名 key、调度 key。
# 凭证仅写入被 git 忽略的 .env，不进入镜像或沙箱。

docker build -f sandbox_runtime/Dockerfile -t agent-demo-runner:0.1.0 .
docker compose up --build -d
```

打开 `http://127.0.0.1:8080`，在页面输入 `.env` 中 `CHAT_API_KEYS` 对象的 key，新建会话即可。模型默认为 `deepseek-flash`；可切换为模型目录中的 `deepseek-v4-pro`。

默认保留 Codex `workspace-write` 内层沙箱。如果 Docker/FC 内核不允许运行其隔离机制，执行会失败，不会自动降级。确认外层容器隔离策略满足要求后，可由部署者显式设置：

```dotenv
CODEX_SANDBOX_MODE=danger-full-access
ALLOW_EXTERNAL_SANDBOX=true
```

这里的 full access 仅发生在一次性外层沙箱里。不存在把模型命令改成在控制机宿主直接执行的后备模式。Docker 方案属于容器隔离，不能宣称与独立 VM 等级完全等价；公网多租户部署应选择经过验收的 FC 沙箱隔离配置。

停止服务：`docker compose down`。执行中的临时沙箱由 worker 清理；中途关闭 worker 后，应重新启动使其回收过期实例。不要手动删除仍需恢复的数据库卷。

## Skill 与 MCP

`config/capabilities.json` 是**部署者维护**的白名单。客户端只传 `skill_refs` 和 `capability_profile`，不能上传任意 MCP 地址或配置。

内置 `data-analysis` skill 与只读 `current_time` 工具。Skill 作为版本快照写入工作区，由 Codex 阅读执行。自定义 skill 脚本依赖需预装进 runner 镜像；沙箱默认不能自由访问互联网安装包。它不自动继承开发者电脑的 skills/MCP。

远程 MCP 走控制层 Tool Broker，stdio 中继只持有短期 attempt token。配置示例和外部写操作恢复见 [API 文档](docs/api.md)。本实现支持 tools/list、tools/call；不包含 MCP resources、prompts、OAuth 授权交互或用户审批 UI。

## FC 部署

FC 函数承载 HTTP 控制层；**FC Agent Sandbox** 承载 Codex。两者是不同的资源。需要 ACR 镜像、E2B 兼容沙箱 endpoint/key、共享 SQL、OSS/S3、定时调度与网关出网规则；因此“DeepSeek URL + key”足够配置模型，但不足以完成整套云部署。

仓库包含 `deploy/fc/s.yaml`、runner 模板镜像、模板构建脚本、网络探针、定时 reconciliation handler。按 [部署步骤](deploy/fc/README.md) 填入真实资源并验收。

## 开发与测试

```bash
python3 -m venv .venv
.venv/bin/pip install -c constraints.txt '.[fc,test]'
npm ci --prefix bridge --registry=https://registry.npmjs.org
```

代码改动后先检查 `git diff`，再选择受影响的测试模块。例如协议变更：

```bash
node --test bridge/test/provider.test.js
.venv/bin/python -m pytest tests/test_bridge.py -q
```

不能用无过滤条件的全量测试替代影响分析。`test_bridge.py` 只启动回环地址上的替身 DeepSeek，无真实 key 或费用。开发时从仓库根目录运行，部署使用 Dockerfile；Python wheel 单独安装不包含外部 Node Bridge 目录。

## 已知范围

- 当前支持文本消息和文件工作区；不是 ChatGPT 全功能复制品。文件不会自动转成 PDF/OCR/Office 内容，需要 skill 和对应镜像依赖。
- briefing 保留全部用户要求、最近六条已提交回复和工具回执；完整旧回复在历史 API。没有把历史摘要冒充无损的 native thread 恢复。
- 超长输入/文件、工具结果不确定、配置变化会显式失败或进入等待态，不会静默丢弃内容。
- 外部写操作无法普遍做到 exactly-once。未知结果暂停；平台管理员核实后才能解除。模型输出不构成外部成功证据。
- 公网部署还需按业务配置 TLS、入口限流、租户配额、监控、密钥轮换与 blob 回收策略。当前只对单次执行的资源、模型请求和输出设上限。

接口兼容依据：[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)、[FC E2B 兼容说明](https://help.aliyun.com/en/functioncompute/e2b-compatibility-explanation)、[FC 网络控制](https://help.aliyun.com/zh/functioncompute/network-access-control)。
