# OSS 持久化部署：forcc-hangzhou（杭州）

本方案只需要 FC + OSS，SQLite 在内存中处理 SQL。每次变更上传加密日志成功后才返回保存成功；
每 25 次提交生成完整快照，冷启动列举提交记录后从最近快照回放。
当前实现不依赖 npm 包，使用 Node.js 24 内置 SQLite、fetch 和 crypto。

## 1. Bucket 和网络

- 控制台：<https://oss.console.aliyun.com/bucket/oss-cn-hangzhou/forcc-hangzhou/object>
- Bucket：`forcc-hangzhou`，地域：`cn-hangzhou`，标准存储、私有访问。
- 专用前缀：`teaching/v1/`；餐饮和酒店分别写入 `catering/commits/`、`hotel/commits/`。
- **Bucket 必须从未启用版本控制**。OSS 的 `x-oss-forbid-overwrite` 在 Enabled 和 Suspended 状态都无效；程序启动及每次写入前会检查。已有版本控制时请另建专用 Bucket，不能仅暂停。
- 不要对此前缀设置删除、归档或低频访问生命周期规则，也不要手动修改或删除日志。
- FC 与 Bucket 均在杭州，FC 部署使用内网地址 `https://oss-cn-hangzhou-internal.aliyuncs.com`，仍需执行角色凭证和 OSS 授权。
  本机不能直接访问阿里云内网 Endpoint，初始化、迁移、导出时在本机 `.env` 中改为 `https://oss-cn-hangzhou.aliyuncs.com`；公网下载会产生 OSS 流出费用。
- 不要把 OSS 挂载为目录后直接运行 SQLite。

## 2. 权限与凭证

控制台上传使用当前登录账号的身份；程序上传必须使用有权限的访问凭据。内网地址不会跳过鉴权。
FC 角色的临时 AccessKey/STS Token 用于 OSS 请求签名；`OSS_STORAGE_KEY` 是应用数据加密密钥，二者用途不同，不能相互替代。

将 `deploy/oss-policy.json` 中的策略授予 FC 执行角色和离线迁移使用的身份。
该策略只允许读取 Bucket ACL/版本状态、列举此前缀及读写此前缀内对象，不含删除和 Bucket 配置权限。
更改 `OSS_PREFIX` 时同步调整策略资源路径和 `oss:Prefix` 条件。

FC 可使用执行角色注入的 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、
`ALIBABA_CLOUD_SECURITY_TOKEN`。确认实际自定义运行时能够提供这三个值；不要将凭据提交仓库或发到聊天中。
环境变量中的 STS 凭据可能到期，长时间运行必须验证运行时刷新机制；本程序不自行申请新 STS 凭据。
可由外部凭据服务原子更新 `OSS_CREDENTIALS_FILE` 指向的 JSON 文件，程序每次请求重新读取：

```json
{"AccessKeyId":"...","AccessKeySecret":"...","SecurityToken":"...","Expiration":"..."}
```

过期或无权限时拒绝确认保存，恢复凭据后重启进程，从 OSS 重建状态。凭据文件使用 `0600` 权限。

## 3. 准备稳定配置

```bash
cp deploy/oss.env.example .env
chmod 600 .env
```

在本机安全编辑 `.env`：

| 变量 | 值 |
| --- | --- |
| `STORAGE_BACKEND` | `oss` |
| `OSS_BUCKET` | `forcc-hangzhou` |
| `OSS_REGION` | `cn-hangzhou` |
| `OSS_ENDPOINT` | `https://oss-cn-hangzhou-internal.aliyuncs.com` |
| `OSS_PREFIX` | `teaching/v1` |
| `OSS_SINGLE_WRITER` | `1`，同时实际限制 FC 最大实例数为 1 |
| `OSS_STORAGE_KEY` | 固定 64 位十六进制密钥，使用 `openssl rand -hex 32` 生成一次并安全保管 |
| `TEACHER_PASSWORD` | 固定初始化密码，至少 8 字符 |
| `CATERING_CLASS_CODE` / `HOTEL_CLASS_CODE` | 固定注册口令，各至少 8 字符 |

密钥必须跨版本保留，丢失后无法恢复数据。初始化变量不会重置数据库内已经修改的教师密码。
`DATA_DIR` 默认为 `/tmp/teaching-cache`，只存临时导出文件，不承担持久化。

## 4. 初始化或迁移（二选一）

先停止所有旧写入进程，包括 FC、旧版本及本地进程。不要蓝绿并行写同一前缀。
正常服务不会自动创建空云端数据库，必须显式执行一次初始化。

### 尚无业务数据

```bash
node --env-file=.env scripts/init-oss.cjs --stopped-writer --empty
```

仅对全新系统执行；不能用它代替迁移。第一次启动服务会创建默认教师、课程任务并提交快照。

### 已有 NAS / 本地 SQLite / 飞书数据

NAS 或本地数据：停写后备份整个数据目录，须包含 `bootstrap.json`、`catering/emenu.sqlite` 和 `hotel/hotel.sqlite`。
不能复制正在写入的 SQLite 文件。将 `.env` 中的三个初始化变量保持为源 `bootstrap.json` 的值。

飞书数据：先在飞书环境执行现有导出脚本，再使用生成的目录：

```bash
node --env-file=/secure/feishu.env scripts/export-feishu.cjs --stopped-writer /secure/teaching-export
node --env-file=.env scripts/init-oss.cjs --stopped-writer --from-dir /secure/teaching-export
```

迁移工具只读源库，执行完整性检查并预检两套目标。上传后回读解密校验。
两套系统不是一个跨对象事务；中断后保持服务停止，以相同源目录和配置重跑，工具仅接受完全相同且未启动过的初始化记录。
目标已有业务记录时拒绝覆盖，可使用新的 `OSS_PREFIX` 重做迁移。保留源备份直至完成真实恢复验收。

## 5. 打包和 FC 配置

按 `deploy/README.md` 使用原 FC 代码/依赖备份及经过 SHA256 校验的 Node 24 Linux 包打包。
`deploy/package.py` 已包含 OSS 模块、迁移工具、环境变量示例和权限策略。

1. 保留原 MCP 环境变量和 HTTP 触发器，把上述 OSS 配置加入 FC。
2. 设置最大实例数为 **1**；`OSS_SINGLE_WRITER=1` 只是声明，不会替你修改 FC 配置。
3. 确保旧进程已停止，启动命令使用 `/bin/bash /code/deploy/bootstrap`，端口 9000。
4. 验证 `/healthz` 中 `storage` 为 `oss`；执行师生登录、保存、提交和批阅。
5. 重建 FC 实例后验证原账号、会话和业务记录仍在。模拟测试不能替代真实权限、签名、STS 刷新及重启恢复验证。

## 6. 故障、备份与限制

- 每条提交用固定递增序号的对象名和 `x-oss-forbid-overwrite=true` 创建，同序号只有一个写入者可以成功。
- 上传响应丢失时回读同一对象核对字节；无法确认则返回 503、停止后续读写，重启恢复后再处理。
  请求可能已在云端提交，不要自动重复提交。当前没有通用业务请求幂等键。
- 单实例限制仍然必要：并发冲突保护不提供多实例读同步或酒店 SSE 广播。
- 数据以 AES-256-GCM 加密、gzip 压缩，AAD 绑定前缀及应用。不要只移动对象到另一前缀；换前缀需导出后重新初始化。
- 恢复失败、日志缺号、密钥错误、Bucket 配置不兼容都会拒绝启动，不会返回空数据冒充恢复成功。
- 默认单个未压缩快照/变更包上限为 128 MiB。日志不自动清理；启动需分页列举全部历史对象（上限 100 万条/应用），再读取最近快照及变更。
  历史增长后需安排停写、导出、迁移到新前缀。不要给日志直接设置按天删除规则。
- 所有历史日志和快照计入存储量；FC 经同地域内网访问不收 OSS 流量费，本机公网下载仍计入流出流量。

停写后导出为可独立恢复的 SQLite 文件：

```bash
node --env-file=.env scripts/export-oss.cjs --stopped-writer /secure/oss-backup
```

输出包括两套数据库、私密初始化配置和 `EXPORT_COMPLETE` 标记，可用于迁回 NAS 或初始化新的 OSS 前缀。
酒店教师端现有数据库备份也可用。回滚代码不删除 OSS 对象，但直接切回旧后端不会包含切换后新增的数据。

参考：[PutObject](https://help.aliyun.com/zh/oss/developer-reference/putobject)、
[V4 签名](https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4)、
[FC 环境变量](https://help.aliyun.com/zh/functioncompute/environment-variables)。
