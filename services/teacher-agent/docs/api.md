# Chat API

除 `/health` 和静态页面外，接口均需 `Authorization: Bearer <token>`。业务接口用 `CHAT_API_KEYS` 中的租户 key；模型与工具接口只接受有效 attempt token；调度/人工核实接口仅接受独立 `CONTROL_ADMIN_KEY`。

## 最小调用

```bash
# CHAT_KEY 在自己的终端设置，不要提交到仓库。
curl -sS -X POST http://127.0.0.1:8080/api/chat/sessions \
  -H "Authorization: Bearer $CHAT_KEY"

curl -sS -X POST "http://127.0.0.1:8080/api/chat/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $CHAT_KEY" -H 'Content-Type: application/json' \
  -d '{"request_id":"my-request-1","message":"写一个统计 CSV 的 Python 脚本并运行","skill_refs":["data-analysis"]}'

curl -N "http://127.0.0.1:8080/api/chat/executions/$EXECUTION_ID/events?after=0" \
  -H "Authorization: Bearer $CHAT_KEY"
```

| 方法与路径 | 含义 |
| --- | --- |
| POST `/api/chat/sessions` | 新建持久业务会话 |
| POST `/api/chat/sessions/{id}/attachments?name=data.csv` | 原始文件 bytes；返回 artifact_id |
| POST `/api/chat/sessions/{id}/messages` | 202 + execution_id/events_url |
| GET `/api/chat/sessions/{id}/history` | 用户消息、最终结果、状态 |
| GET `/api/chat/sessions/{id}/operations` | 外部写操作 ID、参数、状态、回执 |
| GET `/api/chat/executions/{id}` | 状态、attempt_no、result、error |
| GET `/api/chat/executions/{id}/events?after=N` | SSE 断点重放，也支持 Last-Event-ID |
| POST `/api/chat/executions/{id}/cancel` | 封锁能力并请求清理；幂等 |
| POST `/api/chat/executions/{id}/resume` | 显式恢复 WAITING_INPUT，未知写操作必须先核实 |
| GET `/api/chat/artifacts/{id}/download` | 当前租户有权读取的文件 |

消息字段：`request_id` 必填（最多128字符）、`message` 必填（UTF-8最多100KB）、`attachment_ids` 默认[]、`skill_refs` 默认[]、`capability_profile` 默认default。重试同一消息必须复用 request_id，避免创建新执行。

SSE event JSON 包括 `execution_id`、`seq`、`attempt_id`、`type`、`payload`。客户端用 seq 去重。连接约50秒正常轮转，继续带 cursor 订阅。`assistant.delta` 为 provisional；只以 `turn.completed` / COMMITTED 的结果作为已提交答复。重试要区分 attempt，不能把两次输出拼成一个答案。不会把原始 reasoning delta 发给公共 SSE。

附件文件大小4MB，工作区总量16MB、200文件；模型请求正文2MB、每attempt最多64次、单次输出8192 tokens、执行300秒。超过限制不会偷偷截断原文件。大规模任务需调整服务与 runner 的配套限额并验收。

## 自定义 MCP

在 `config/capabilities.json` 中增加工具并纳入 profile：

```json
{
  "name": "ticket_create",
  "kind": "mcp",
  "effect": "write",
  "description": "Create a ticket after user instruction",
  "url": "https://your-trusted-mcp.example/mcp",
  "remote_name": "create_ticket",
  "bearer_env": "TICKET_MCP_TOKEN",
  "schema": {
    "type": "object",
    "properties": {"title": {"type": "string"}},
    "required": ["title"],
    "additionalProperties": false
  }
}
```

`tools` 是以工具名为 key 的对象，示例中的 name 可以省略。secret 用 `bearer_env` 引用，只注入 control/worker；不能写进 JSON、skill 或 runner 镜像。添加该 profile 到对应租户 key 的 `profiles` 才能调用。

只读工具声明 read。实际有外部副作用的工具必须声明 write。SDK 传输使用 MCP Streamable HTTP，支持 JSON/SSE 响应；按调用建立会话、initialize、initialized、tools/call。对永久会话依赖、OAuth 续签或特殊服务器需另外适配。

## 未知写结果人工核实

外部调用超时或返回 isError 不等于外部未执行，execution 进入 WAITING_INPUT。通过 operations 查询 ID，在外部系统核实；等待沙箱清理后，用管理员 key 调用：

```http
POST /internal/operations/{operation_id}/resolve
Authorization: Bearer <CONTROL_ADMIN_KEY>
Content-Type: application/json

{"outcome":"confirmed","evidence":{"external_id":"ticket-123","checked_by":"operator"}}
```

`not_applied` 记录已核实未执行，作为拒绝回执。已有同参数调用不会自动再次提交；若确需重新发起，创建新的明确业务请求。核实后业务客户端调用 `/resume`。不能用助手声称“已经完成”作为 evidence。

`/internal/tick` 是有鉴权、单次有界的调度入口，不是后台任务启动后立即返回。生产调度需独立于浏览器连接，并监控连续失败。
