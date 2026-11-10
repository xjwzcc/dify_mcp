# ECS 教师助手

网站仍以 `teaching` 用户运行。`TEACHER_AGENT_MODE=ecs-external` 让网站只启动
OSS 持久化代理，由独立 `shixunlab-agent.service` 启动可信 Python 控制服务和 Bridge。
模型命令仍只在独立 UID、无网络 bubblewrap 沙箱中执行，不允许宿主执行 fallback。

控制服务使用 root 身份，但 capabilities 仅保留 CHOWN、DAC_OVERRIDE、FOWNER、SETUID、SETGID、KILL；
保留 NoNewPrivileges、只读系统、私有临时目录和 ProtectHome。网站没有这些权限。
发布目录由 root 持有，网站用户不能修改控制服务源码。服务签名密钥保存在 root 0600 的
`/etc/shixunlab/agent-web.env` 和 `agent-control.env`，通过 systemd 注入；模型密钥只传给控制服务。

使用系统 Python 3.11，重新安装 native wheel 到本次发布目录的 `python311/`，不能复用 FC 的
Python 3.10 二进制依赖。Agent 的 `bin` 显式连接本次发布的 `../../bin`，运行代码目录可遍历，
沙箱 runner 可读取。已有云凭据刷新服务和课堂数据目录保持现有配置。

2 GiB 主机的网站 MemoryMax 为 768 MiB、控制服务为 896 MiB；单执行、单保留沙箱，模型进程 RSS
采样上限 256 MiB。内存预检读取本服务及祖先 cgroup 的最小上限，控制服务预留 256 MiB，
该配置至少需要 576 MiB。此上限不能替代真实负载容量评估。

部署包中的 `manifest.json` 固定线上基线和上传文件 SHA256。`ecs-agent-deploy.py stage` 检查基线、
复制当前发布到新目录、只覆盖列出的 Agent 文件并安装依赖，不切换线上版本。
`activate` 先执行现有 OSS 备份、私下备份配置，再安装独立服务、切换发布并重启；健康检查失败自动
恢复旧发布及服务配置。部署时需评审新增控制服务权限。无需开放任何公网端口。

```bash
python3.11 deploy/ecs-agent-deploy.py stage /opt/shixunlab/releases/<新版本> --source <解包目录>
python3.11 deploy/ecs-agent-deploy.py activate /opt/shixunlab/releases/<新版本>
systemctl status shixunlab shixunlab-agent
curl -fsS http://127.0.0.1:9000/healthz
```

网站不等待独立控制服务启动，以便控制服务在网站持久化代理就绪后启动。控制服务跟随网站重启，
先恢复 OSS 快照并隔离旧 attempt；健康接口每次查询控制服务，恢复后不保留旧故障状态。

## 2026-11-04 部署验收

用户批准独立控制服务的最终六项 capabilities 后，已切换到
`/opt/shixunlab/releases/20261104-agent1`。旧版本保留，现有 OSS 备份执行成功。
首次切换因 `UMask=0077` 把沙箱父目录收紧为 0700 而未通过预检，自动回滚已实际触发并恢复课堂；
修复后显式将两个共享控制目录设为 0711，保留普通文件 0600 和每会话目录 0700，再次部署成功。

- HTTPS `/healthz` 返回三个课堂服务正常、`agent:true`。
- 网站仍为普通 `teaching` 用户，控制服务仅具有上述六项 capabilities，两者 NRestarts 均为 0。
- accounts、catering、hotel、Agent 四个 SQLite 的只读 `PRAGMA quick_check` 均为 `ok`。
- 真实 systemd 同权限临时单元通过沙箱隔离预检、keeper 启动、沙箱内 Codex 0.162.0 检查和回收；
  使用现有 Bridge/DeepSeek 的真实模型探测计算 2+2，返回 4。没有修改课堂或 Agent 对话记录。
- 已有学生账号的两门课堂进入/读取正常；匿名访问助手返回 401，学生访问返回 403。
- 原有未批准测试教师账号仍返回 403，未修改账号审批状态。因此没有覆盖真实教师浏览器中的完整对话、
  附件上传/下载、多轮工具调用和取消流程；也未覆盖多教师并发、长期资源占用或所有移动浏览器。

实际执行的针对性测试（仓库根目录；没有运行全量测试）：

```bash
/Users/bytedance/.nvm/versions/node/v22.22.3/bin/node --test tests/teacher-agent-runtime.test.cjs tests/teacher-agent-gateway.test.cjs tests/teacher-agent-persistence.test.cjs tests/integration.test.cjs
# 10 passed；首次在受限沙箱内因端口/Unix socket EPERM 失败，获自动审核允许后在沙箱外运行通过。
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py
# 最终 24 passed，包含私有文件掩码、cgroup v1/v2、持久化和清理测试。
python3 -m unittest discover -s tests -p test_ecs_agent_deploy.py -v
# 2 passed
python3 data/ecs-agent-fix-20261104/live-smoke.py
# 线上 HTTPS、课堂读取、匿名/学生权限通过；测试教师登录 403。
git diff --check
```

线上实际执行的隔离探测命令：

```bash
systemd-run --unit=shixunlab-agent-check-20261104 --wait --pipe --collect -p User=root -p Group=root -p EnvironmentFile=/etc/shixunlab/agent-control.env -p WorkingDirectory=/opt/shixunlab/current/services/teacher-agent -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectHome=true -p ProtectSystem=strict -p UMask=0077 -p MemoryMax=896M -p TasksMax=128 -p LimitNOFILE=1024 -p 'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID CAP_KILL' /usr/bin/python3.11 /opt/shixunlab/current/deploy/ecs-agent-live-check.py
```

发布目录保留 `agent-python311.lock.txt` 和 `agent-release-manifest.json`。服务器 PyPI 下载较慢，
本次依赖最终通过阿里云 PyPI 镜像安装，原生 3.11 导入检查通过。所有私有配置和部署回滚副本仅保留于服务器，
没有提交凭据、课堂数据、数据库或教师会话。

## 2026-11-04 教师页面报错修复

用户截图中的 `utf-8 ... byte 0xa3 in position 45` 来自技能目录中的 macOS
AppleDouble `._SKILL.md` 二进制文件。注册表递归读取文本时错误地包含了该文件。
技能加载及发布复制现已忽略 AppleDouble、Finder 元数据和 Python 缓存；真正的技能文本
仍严格使用 UTF-8，非法文本返回明确错误，不使用丢弃字符的解码方式。

真实教师对话随后暴露了另一个问题：ECS 的 `/usr/bin/python3` 依赖
`/etc/alternatives`，该路径在隔离沙箱中不存在，导致业务 MCP 启动失败。
MCP 配置现使用 runner 的 `sys.executable`，沙箱增加指向同一解释器的 `python3`
别名并放入 PATH，不增加宿主 `/etc` 挂载或放宽网络隔离。

最终发布为 `/opt/shixunlab/releases/20261104-agent3`，agent1、agent2 保留用于回滚。
两次修复均先执行现有 OSS 备份、备份配置并验证源码哈希；仅重启独立 Agent，
课堂网站进程保持运行。最终健康检查三个课堂服务和 Agent 全部正常。

使用用户已登录的正式教师身份，在独立验收标签页提交中文只读问题，实际完成：

- 中文消息提交、沙箱模型执行、`get_course_overview` 和 `list_workorders` 工具查询。
- 页面显示学生 7 人、已发布任务 4 个、待批阅 0 份，并显示“已保存”。
- 刷新验收标签页后显示“历史记录已恢复”，回答及工具依据完整保留。
- 数据库执行为 `COMMITTED`、一次 attempt、4 次模型请求、2 条工具依据和 `turn.completed`。
- 验收会话已结束，沙箱已释放；用户原标签页的消息草稿未改动。

这次真实教师浏览器验收补足了上节初次部署的对话验证缺口。当前仍未覆盖附件上传/下载、
取消、多教师并发、长期资源占用和全部移动浏览器。餐饮课程覆盖了针对性 API 回归，
未单独运行线上浏览器对话。

本次新增修复实际执行的针对性测试（11 passed，没有运行全量测试）：

```bash
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_capabilities.py services/teacher-agent/tests/test_teaching.py::test_metadata_sidecars_do_not_break_chinese_message_submission services/teacher-agent/tests/test_teaching.py::test_signed_api_isolation_idempotency_and_history
# 6 passed
python3 -m unittest discover -s tests -p test_ecs_agent_deploy.py -v
# 3 passed
services/teacher-agent/.venv/bin/python -m pytest -q services/teacher-agent/tests/test_fc_internal.py::test_internal_boundary_has_no_host_mount_or_network services/teacher-agent/tests/test_sandbox.py::test_mcp_uses_runner_interpreter_instead_of_host_python_alternatives
# 2 passed
git diff --check
```
