# ECS 师生数据 OSS 备份

当前课堂数据在 `/var/lib/shixunlab`。发布代码只写 `/opt/shixunlab/releases/<版本>`，
不能把本地 `data/`、旧 FC 导出或空 SQLite 覆盖到线上数据目录。

## 已上线验证（2026-11-03）

18:00（北京时间）完成首次真实备份与 OSS 回读；每小时 timer 已启用。
ECS `114.215.169.27` 已绑定 `ShixunlabEcsBackupRole`，用户在控制台将对应最小权限
自定义策略保存为 `cc`；策略内容与 `ecs-backup-policy.json` 等价，无删除权限。

首次备份 manifest：
`teaching/v1/ecs-backups/2026-11-03T10-00-13-469Z-ac90ea6e-80b8-443c-a938-2330837f51ba/manifest.bin`。
从 OSS 恢复到 `/var/backups/shixunlab/restore-check-20261103-1801`，所有文件哈希、
三个数据库完整性及表行数均通过；没有覆盖线上目录。服务仍 active，HTTPS 返回 200。
systemd 单元校验通过，启动前备份门禁已加载；未为测试门禁而重启生产网站。
下一次定时触发显示为 19:00:32；尚未等待整点自然触发或模拟服务器故障。

## 备份机制

- `shixunlab-backup.timer` 每小时执行，最多随机延迟 60 秒；关机错过后补执行一次。
- `node:sqlite.backup()` 对账号、餐饮、酒店三个数据库分别创建一致快照，包含已提交 WAL 数据。
  在线备份的三个快照不保证同一时刻的跨库事务；部署重启前在应用停止后再备份。
- 包含 `bootstrap.json`、`catering/login.json`、`hotel/config.json`，保留原初始化配置。
  不包含服务器 TLS 私钥、备份解密密钥和服务器环境文件；这些配置需另行安全保管。
- 每个数据库检查完整性并记录表行数；按 4 MiB 分块 gzip + AES-256-GCM 加密，AAD 绑定对象路径。
- 写入私有 Bucket `forcc-hangzhou` 的独立前缀 `teaching/v1/ecs-backups/`。
  每块上传后 GET 回读核对；最后上传加密 manifest，只有 manifest 存在才是完整备份。
- 不覆盖旧备份、不删除对象、不修改 FC 的 `*/commits/` 历史。默认保留所有成功备份；
  会随备份数量产生 OSS 存储占用，保留期限需另行确定，不能给旧 FC 提交日志设置自动删除。
- 临时快照正常结束后删除，成功时间/对象名/数据库规模在
  `/var/backups/shixunlab/last-success.json`；错误进入 systemd journal，退出码非零。
  未配置邮件或短信告警。失败后下一次定时执行重试；有失败时恢复点可能早于一小时前。
- 文件分块避免把整个数据库读入内存。备份服务独立限制 384 MiB，与网站服务分开。
  备份前要求工作盘可用空间至少为源文件体积的两倍加 256 MiB；不足时保留旧备份并失败。

## 首次安装

1. 创建 `ShixunlabEcsBackupRole`：信任策略见 `ecs-backup-role-trust.json`；
   自定义权限策略见 `ecs-backup-policy.json`。只允许此备份前缀的读写/列举和 Bucket 属性读取，
   无删除、公开访问、其他业务数据目录权限。绑定到目标 ECS 实例。
2. 将 `ecs-backup.env.example` 安装为 `/etc/shixunlab/backup.env`，`root:root 0600`。
   `OSS_STORAGE_KEY` 使用迁移时已安全保留的固定密钥，不能每次发布随机生成。
   ECS 角色通过 IMDSv2 获取短期凭据并自动刷新，不把一次性 STS 凭据写死在环境文件。
3. 上传经过审核的备份代码包，运行：

   ```bash
   bash /path/to/reviewed-source/deploy/ecs-backup-install.sh
   ```

安装脚本先执行一次真实上传和回读；成功后才启用 timer 和网站重启前的备份门禁。
工具放在独立 `/opt/shixunlab/backup`，避免随课堂代码切换而丢失。
备份凭据只进入备份服务，不进入课堂 Node 进程。安装不会重启正在运行的网站。

## 发布保护

更新使用 `bash deploy/ecs-setup.sh /opt/shixunlab/releases/<新版本>`：已有服务必须先成功备份，
才切换 `current`；原 `app.env` 保留。随后 `systemctl restart shixunlab` 时，
systemd 的 `backup.conf` 再在新应用启动之前执行备份。任何数据库缺失、校验失败、
OSS 上传失败或回读失败都会阻止启动新代码，不能默默创建空库。

门禁使 OSS 不可用时重启也会失败。这是防止无备份更新的明确取舍；不要删除门禁后宣称已备份。
已运行的网站不会因为定时备份失败而被停止。现有服务的手动直接 `node server.cjs` 不经过门禁；
生产只能通过 systemd 管理。备份不替代数据库迁移审查；旧代码不一定兼容新数据库结构。

## 检查与恢复演练

```bash
systemctl list-timers shixunlab-backup.timer
systemctl show shixunlab-backup.service -p Result -p ExecMainStatus
journalctl -u shixunlab-backup.service -n 20 --no-pager
cat /var/backups/shixunlab/last-success.json
```

用备份记录中的完整 `manifestKey` 恢复到一个不存在的新目录（需 root）：

```bash
/opt/node-v24.10.0-linux-x64/bin/node --env-file=/etc/shixunlab/backup.env \
  /opt/shixunlab/backup/scripts/backup-ecs.cjs restore \
  teaching/v1/ecs-backups/<备份版本>/manifest.bin /var/backups/shixunlab/restore-check-<时间>
```

恢复逐块解密、检查 SHA-256，检查完整文件哈希、SQLite 完整性及表行数。
只有全部通过才写 `EXPORT_COMPLETE`。已有目标目录一律拒绝覆盖；不会自动把旧数据切回线上。
正式恢复先停写、保留当前数据目录，再审核恢复版本并设置 `teaching:teaching` 所有权后替换。
不要对正在写入的 SQLite 只复制 `.sqlite` 主文件，遗漏 WAL 会丢失最近提交。

每小时备份不是零丢失实时复制。正常更新保留原数据；磁盘完全损坏时只能恢复到最近成功备份。
需要更小恢复窗口时可以缩短 timer 或另行设计实时复制。

## 本地专项验证

```bash
node --test tests/ecs-backup.test.cjs
bash -n deploy/ecs-backup-install.sh deploy/ecs-setup.sh
```

覆盖 WAL 数据、跨分块恢复、原库不被改写、旧版本保留、上传响应丢失、上传失败、
数据损坏、错误密钥/对象路径、私有 Bucket 检查及角色凭据刷新。
不运行全量测试；本地模拟 OSS 不代表实际 RAM 授权、定时器和生产恢复已验证。
