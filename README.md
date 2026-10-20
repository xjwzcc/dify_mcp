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

初次启动会在 `DATA_DIR/bootstrap.json` 生成随机教师密码和两门课程的注册口令。
默认 `DATA_DIR=./data`。教师账号为 `teacher`；管理员通过服务器安全读取此文件后分发，
不要将它放入仓库、网站或公开部署包。两个课程初始教师密码相同，后续各自维护。
初始化也可用环境变量 `TEACHER_PASSWORD`、`CATERING_CLASS_CODE`、`HOTEL_CLASS_CODE` 指定。
已有数据库不会因修改初始化变量而重置密码。

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
- `tests/integration.test.cjs`：合并路由、鉴权、保存、批阅、事件流及重启恢复专项测试。

原始文档记录的是独立部署方式；合并部署以本 README 和 `deploy/README.md` 为准。

## 定向验证

按改动选择测试，不默认运行全部测试：

```bash
node --test tests/integration.test.cjs
```

测试使用临时数据库，不修改真实课堂数据。
