# 吴山苑教学实训平台与酒店 MCP

统一仓库包含餐饮教学系统、酒店人力资源教学系统和原酒店 MCP 服务。
两套教学系统各有教师端和学生端；账号、Cookie、SQLite 数据库和课程记录分别隔离。
本次为统一入口与部署整合，不自动合并两套系统的学生档案或成绩。

## 启动

需要 Node.js 24。教学系统使用内置 HTTP、SQLite，无需 npm 安装依赖。

```bash
node server.cjs
```

访问 `http://localhost:9000`：

| 地址 | 功能 |
| --- | --- |
| `/` | 统一课程入口 |
| `/catering/teacher`、`/catering/student` | 餐饮教师端、学生端 |
| `/hotel/teacher`、`/hotel/student` | 酒店教师端、学生端 |
| `/healthz` | 所有已启用服务的健康检查 |
| `/mcp` | 原 MCP 服务信息（启用 MCP 时） |
| `/sse`、`/messages` | 原 MCP 接口，地址保持不变 |

默认 `STORAGE_BACKEND=nas`，在本地开发时使用本地 SQLite，在 FC 正式部署时要求 NAS 挂载。
此模式初次启动会在 `DATA_DIR/bootstrap.json` 生成随机教师密码和两门课程的注册口令。
默认 `DATA_DIR=./data`。教师账号为 `teacher`；管理员通过服务器安全读取此文件后分发，
不要将它放入仓库、网站或公开部署包。两个课程初始教师密码相同，后续各自维护。
初始化也可用环境变量 `TEACHER_PASSWORD`、`CATERING_CLASS_CODE`、`HOTEL_CLASS_CODE` 指定。
已有数据库不会因修改初始化变量而重置密码。

## 飞书小规模验证

已增加 `STORAGE_BACKEND=feishu`，通过飞书多维表格持久化两套系统的数据，NAS 模式保留。
详细的申请入口、权限、初始化、FC 配置及恢复步骤见 [飞书试点指南](deploy/FEISHU.md)。

```bash
cp deploy/feishu.env.example .env
# 在本机编辑 .env，完成飞书初始化和凭据配置后：
node --env-file=.env server.cjs
```

该模式使用专用的加密数据表作为存储日志，不是可供教师直接编辑的业务表格。
只允许一个活动部署；API 写入确认后才返回保存成功。每 25 次提交建立恢复快照，
实例重启从飞书恢复；恢复失败直接拒绝启动，不会创建空数据库冒充原数据。
试点需要关注接口配额、表格行数、保存延迟和冷启动时间。尚未验证 1000 人同时在线的容量。

原系统每套只有一个 `teacher` 教师账号。酒店支持多班级；餐饮仍使用统一注册口令。
本次存储改造未增加 50 个独立教师账号或按授课关系划分教师权限。

## 原 MCP

保留 MCP 时先安装根目录 `requirements.txt` 的 Python 依赖，再执行：

```bash
ENABLE_MCP=1 node server.cjs
```

MCP 所需第三方服务凭据沿用原 FC 环境。不要将云端配置导出文件提交到 Git。

## 目录

- `apps/catering/`：餐饮源码及原始文档。
- `apps/hotel/`：酒店人力资源源码及原始文档。
- `portal/`、`server.cjs`：统一入口、内部服务管理、流式代理。
- `deploy/`：FC 部署与打包说明。
- `storage/`：可切换的 SQLite/NAS 与飞书持久化适配器。
- `scripts/init-feishu.cjs`、`scripts/export-feishu.cjs`：专用表初始化、停写后导出到 NAS。
- `tests/integration.test.cjs`：合并路由、鉴权、保存、批阅、事件流及重启恢复专项测试。

原始文档记录的是独立部署方式；合并部署以本 README 和 `deploy/README.md` 为准。

## 定向验证

按改动选择测试，不默认运行全部测试：

```bash
node --test tests/integration.test.cjs
# 飞书适配器改动对应的模拟故障测试：
node --test tests/feishu-storage.test.cjs
# 飞书模式下的应用流程、10 班 10 人并发保存、冷恢复及 NAS 导出：
TEST_STORAGE_BACKEND=feishu node --test tests/integration.test.cjs
```

测试使用临时数据库和本机模拟飞书接口，不修改真实课堂数据。
模拟测试不覆盖飞书真实权限、限额、主从延迟、FC 冷启动或真实 NAS 锁语义。
