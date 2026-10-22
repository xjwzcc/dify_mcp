# 吴山苑教学实训平台与酒店 MCP

统一仓库包含餐饮教学系统、酒店人力资源教学系统和原酒店 MCP 服务。
两套教学系统各有教师端和学生端，课程数据库、Cookie 和课程记录分别隔离。
统一账号中心支持注册并绑定两套课程的原账号，保留各自的学生档案和成绩。

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

## OSS 持久化（forcc-hangzhou）

### 本地页面连接已部署的 FC

需要 Node.js 24，无需安装依赖：

```bash
npm run dev:fc
# 或：node scripts/dev-fc-proxy.cjs
```

打开 `http://127.0.0.1:19081`。HTML/JS/CSS 来自本地代码，两个课程的 `/api/*` 请求
转发到 FC，由 FC 统一写入 OSS。使用线上师生账号；保存、提交与批阅会真实修改线上数据。
这不同于 `19080` 的隔离数据副本，测试请使用独立测试账号。

默认连接当前杭州函数，支持 `FC_BASE_URL=https://你的函数域名 LOCAL_PORT=19081 npm run dev:fc`。
本地不需要 OSS AccessKey 或加密密钥，也不会启动第二个 OSS 写入实例。
代理仅监听回环地址，校验 Host/Origin，保留 Cookie 登录和事件流；只在本机 HTTP 响应中适配 Cookie 的 Secure/Domain 属性。
不要将此开发代理暴露到公网。原 MCP 接口不在此代理范围。

代理专项测试：`node --test tests/dev-fc-proxy.test.cjs`。

### 其他电脑首次使用

安装 Git 和 Node.js 24 后，在终端执行（Windows、macOS、Linux 通用）：

```bash
git clone https://github.com/xjwzcc/dify_mcp.git
cd dify_mcp
npm run dev:fc
```

已有仓库时，先处理本地改动，再运行 `git pull --ff-only` 更新。无需 `npm install`。
打开 `http://127.0.0.1:19081/accounts/`，用线上统一账号登录或注册，绑定课程后进入。
学生首次加入课程需要教师提供班级口令；教师注册需要一次性邀请码。
默认 FC 地址为 `https://cc-dify-mcp-wvsdgstfwa.cn-hangzhou.fcapp.run`。
电脑需要能联网访问该地址；如果仓库是私有仓库，下载代码还需自己的 GitHub 仓库访问权限。

| 信息 | 日常本地使用是否需要 |
| --- | --- |
| 线上统一账号与密码 | 需要；各人使用自己的账号 |
| 班级口令 / 教师邀请码 | 首次加入课程 / 教师注册时需要 |
| OSS AccessKey、STS Token、`OSS_STORAGE_KEY` | 不需要；由 FC 执行角色及服务端配置管理 |

不要把部署环境文件、账号密码、加密密钥或 `data/` 目录提交到 Git。
多台电脑可同时通过代理使用，写入由同一个 FC 服务处理。
`npm start` 默认启动本地 SQLite 服务，并不会自动连接现有线上数据。
日常使用不要运行 OSS 初始化或迁移脚本，也不要另起后端直接写同一 OSS 前缀。

### FC 存储配置

新增 `STORAGE_BACKEND=oss`，使用杭州 `forcc-hangzhou` Bucket 保存加密提交日志和定期快照，实例冷启动恢复内存 SQLite。
配置示例见 `deploy/oss.env.example`，初始化、迁移、权限及部署步骤见 [OSS 部署指南](deploy/OSS.md)。
FC 与 Bucket 均位于杭州，部署默认使用杭州 OSS 内网 Endpoint；本机迁移时使用公网 Endpoint。只支持一个活动部署；云端确认后才返回保存成功。
Bucket 必须私有且从未开启版本控制。切换前需要显式初始化或迁移，直接改环境变量不会迁移旧数据。

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
- `storage/`：可切换的 SQLite/NAS、飞书与 OSS 持久化适配器。
- `scripts/init-feishu.cjs`、`scripts/export-feishu.cjs`：专用表初始化、停写后导出到 NAS。
- `tests/integration.test.cjs`：合并路由、鉴权、保存、批阅、事件流及重启恢复专项测试。

原始文档记录的是独立部署方式；合并部署以本 README 和 `deploy/README.md` 为准。

## 定向验证

按改动选择测试，不默认运行全部测试：

```bash
node --test tests/integration.test.cjs
# 飞书适配器改动对应的模拟故障测试：
node --test tests/feishu-storage.test.cjs
# OSS 签名、提交冲突、故障恢复及迁移：
node --test tests/oss-storage.test.cjs tests/oss-migration.test.cjs
# OSS 模式应用流程与冷恢复：
TEST_STORAGE_BACKEND=oss node --test tests/integration.test.cjs
# 飞书模式下的应用流程、10 班 10 人并发保存、冷恢复及 NAS 导出：
TEST_STORAGE_BACKEND=feishu node --test tests/integration.test.cjs
```

测试使用临时数据库和本机模拟飞书/OSS 接口，不修改真实课堂数据。
模拟测试不覆盖飞书/OSS 真实权限、限额、网络延迟、STS 凭据刷新、FC 冷启动或真实 NAS 锁语义。


## 统一账号注册与绑定

访问 `/accounts/` 登录，或 `/accounts/#register` 注册。学生、教师各有独立个人账号；统一账号与每门课程的原学号分开保存。

- 学生：注册后，对每门课程选择“绑定原账号”，输入原学号和原密码；验证后保留原学号、作业、成绩和业务存档。每个课程账号只能绑定一个统一账号，不能覆盖或自动合并已有绑定。
- 新生：选择“首次加入课程”，用教师提供的班级口令创建课程档案；酒店课程还需选择已开放注册的班级。新档案学号使用统一账号名。
- 教师：凭一次性邀请码注册。现有教师可在账号中心登录后生成邀请码；首次开通时，在登录页展开“已有教师：生成注册邀请码”，用原餐饮教师密码验证。邀请码有效 7 天，注册成功即失效。教师账号具有当前系统中两门课程的教学管理权限（尚未按教师隔离班级）。
- 登录账号中心后点击课程入口即可进入，不必再输入课程密码。退出统一账号会撤销该账号中心会话开启的课程会话；原入口独立登录的会话仍按原规则管理。
- 原课程登录入口继续可用。统一账号密码独立于原课程密码；当前没有自助找回统一账号密码功能。

账号服务默认监听内部端口 `9104`（`ACCOUNTS_PORT` 可改），由统一网关转发。独立的加密 OSS 目录为 `teaching/v1/accounts/commits/`，首次启动自动建立，不改变已有餐饮与酒店数据库结构；现有 `teaching/v1/*` 授权覆盖它。账号目录应与两个课程目录一起保留和备份。支持当前 OSS 部署和本地 SQLite；旧飞书模式不启用统一账号服务。

本地代理 `npm run dev:fc` 同样支持账号中心，前提是 FC 已部署含账号服务的新代码。
针对性测试：`node --test tests/accounts.test.cjs tests/dev-fc-proxy.test.cjs`（临时 SQLite 和模拟 OSS，包含绑定、权限、重启恢复、退出撤销）。
