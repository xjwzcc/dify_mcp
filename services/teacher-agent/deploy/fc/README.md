# 阿里云 Function Compute 部署

这里把**普通 FC 函数**用于控制服务，把**FC Agent Sandbox**用于不可信 Codex 执行。普通 FC 进程本身不是本项目的租户沙箱。云资源尚未由本次开发创建；下列模板必须在自己的账号、地域和网络中验收。

## 1. 准备基础资源

- ACR 中两个 linux/amd64 镜像：control、runner 模板基础镜像。
- FC Agent Sandbox 已开通的地域、API key、`E2B_API_URL` 与 `E2B_DOMAIN`。不要照抄示例地域，使用控制台实际值。
- 共享 MySQL 8 数据库（或另行安装对应 SQLAlchemy 驱动的 PostgreSQL）；禁止将 FC `/tmp` 的 SQLite 作为生产状态。
- 私有 OSS bucket 的 S3 兼容 endpoint/凭证，或经过验证的 S3 服务。验证上传、读取及 SHA256 校验；不得给沙箱这些凭证。若本账号 OSS 不提供所需 S3 兼容认证，需替换 `Blobs` adapter，不能把 URL 改名后视为已接通。
- 稳定 HTTPS 网关域名/IP，以及 sandbox 到网关的出网白名单。SQL 若在 VPC，给 control/scheduler 添加本账号的 `vpcConfig`、安全组/交换机；模板未虚构这些 ID。control 还需要到 DeepSeek、OSS、E2B API 的网络路径。
- 用部署工具的密钥注入或受控环境变量传递 `.env.example` 中的配置。不要把 key 填入 s.yaml 并提交。

## 2. 构建镜像和沙箱模板

```bash
docker buildx build --platform linux/amd64 -t "$CONTROL_IMAGE" --push .
docker buildx build --platform linux/amd64 -f sandbox_runtime/Dockerfile \
  -t "$RUNNER_BASE_IMAGE" --push .
docker buildx build --platform linux/amd64 -f deploy/fc/Dockerfile.runner \
  --build-arg RUNNER_IMAGE="$RUNNER_BASE_IMAGE" -t "$RUNNER_FC_IMAGE" --push .

# E2B 2.31.0 已在项目 fc extra 固定；REGISTRY_USERNAME/PASSWORD 仅用于私有镜像拉取。
.venv/bin/python scripts/fc_template.py --image "$RUNNER_FC_IMAGE" --name agent-demo-runner
```

将输出的 template_id 设置为 `FC_TEMPLATE`。FC template 镜像不自行启动 runner；由 worker 在完成文件上传后通过 `commands.run` 启动。确认模板内 `/opt/runner/main.py`、`codex`、`python3`、用户 `agent` 和可写 `/runs` 可用。

## 3. 初始化持久状态和部署控制服务

配置 `SANDBOX_PROVIDER=fc`、共享 `DATABASE_URL`、`BLOB_BACKEND=s3`、blob 配置和全部控制层凭证。首次部署在可访问数据库的可信环境执行一次：

```bash
# 使用相同 control 镜像与凭证；这只初始化本项目表。
docker run --rm --env-file .env "$CONTROL_IMAGE" agent-demo init-db
```

初始化不是每个请求自动执行的操作，已有生产表升级需设计数据库 migration。`DATA_DIR=/tmp/agent-demo` 仅放临时数据；真正 blob 使用对象存储。

首次先部署 control，配置自有 HTTPS 域名后填好 `GATEWAY_URL`，再次部署同一 control 并部署 scheduler。`s.yaml` 通过 `${env(...)}` 读取配置。Serverless Devs 的账号凭证由 `s config` 管理，与 E2B key 是两套凭证。

```bash
cd deploy/fc
s control deploy
# 完成 HTTPS 域名/入口设置并更新 GATEWAY_URL 后：
s control deploy
s scheduler deploy
```

HTTP trigger 的 anonymous 只表示 FC 不拦截签名，本应用所有敏感接口仍验证独立 Bearer key；外部入口应增加 TLS、限流和适合业务的身份代理。`/health` 和静态页面可公开。

control 单实例并发20，支持模型请求、事件流、tick 同时进行。FC HTTP/自定义域名必须实测流式传输；如入口缓冲 SSE，仍可轮询 status/history，不能声称已实现实时流。

## 4. 出网验收

将 `FC_EGRESS_CIDRS` 设置成只允许网关的 IP/CIDR（例如 `["10.0.0.10/32"]` 是占位值）。本实现主动拒绝 0.0.0.0/0、::/0、链路本地和阿里云 metadata 地址。FC 规则是否实际生效必须由数据面探针确认：

```bash
.venv/bin/python scripts/fc_probe.py
```

探针会产生一个短期 sandbox 并在 finally 中 kill，检查网关、普通公网、两类 metadata 地址；它不会自动写入 `FC_NETWORK_VERIFIED`。还需根据真实环境补测 IPv6、同 VPC 非网关地址、DNS 通道和租户间网络隔离。验收后显式设置 `FC_NETWORK_VERIFIED=true` 并重新部署 control。未设置时 worker 拒绝创建沙箱。

默认 `workspace-write`。若平台无法嵌套 Codex 内层沙箱，先确认外层隔离满足部署要求，再显式设置 `CODEX_SANDBOX_MODE=danger-full-access` 和 `ALLOW_EXTERNAL_SANDBOX=true`。没有静默降级。

## 5. 调度与恢复

`agent-demo-scheduler` 每分钟触发一次；每次在45秒内约每10秒调用一次 `/internal/tick`。tick 负责轮询、续租、提交、清理和最多一次新分配。调用超时最长210秒，FC timeout240秒。租约默认60秒；连续调度失败会导致过期、fence 旧 token 并创建新 attempt。若实际创建沙箱耗时很长，先提升调度容量/拆分领取与监控，避免单 tick 阻塞影响续租。

高吞吐部署应使用独立调度服务和队列触发更多有界 tick。该 demo 每次扫描最多20个活跃 attempt，不承诺无限并发。**不要将 worker 循环塞进 FC 的 HTTP 响应之后**，函数冻结会破坏这种假设。

可以由受控作业平台手动触发：

```bash
.venv/bin/python scripts/fc_tick.py
```

## 6. 上线前端到端验收

1. 提问、调用 current_time、执行数据分析 skill，检查工具事件、最终回复和文件下载。
2. 第二条消息要求引用第一轮生成文件，检查重建后的工作区和业务历史。
3. 模型/工具期间取消，确认 token 立即失效、sandbox 最终销毁、没有迟到提交。
4. 关闭一次调度调用或杀死控制实例，恢复后重复请求不能造成双提交。
5. 两个 tenant 互访 session、artifact、event 返回拒绝。
6. 在专用测试 MCP 中模拟写操作超时，确认 WAITING_INPUT 且不自动重放。
7. 观察长任务的 SQL 连接、沙箱 TTL、SSE 代理缓冲、候选 blob 堆积和费用。

没有这些真实云验收结果之前，请将此部署作为参考实现/测试环境。

依据：[FC 模板从镜像构建](https://help.aliyun.com/en/agentrun/agenrun-sandbox-upgrade-fc-cloud-sandbox-scheme)、[FC E2B 兼容性](https://help.aliyun.com/en/functioncompute/e2b-compatibility-explanation)、[网络访问控制](https://help.aliyun.com/zh/functioncompute/network-access-control)、[Serverless Devs fc3](https://github.com/devsapp/fc3)。
