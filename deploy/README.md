# 部署至已有 FC：cc_dify_mcp

地域：`cn-hangzhou`。原函数是 Debian 10 自定义运行时、Python 3.10、端口 9000。
保留 Python 依赖与原 MCP；增加 Node.js 24 Linux x64 运行时，统一服务监听 9000。

## 存储先决条件

现有函数未挂载 NAS/OSS。禁止使用 `/tmp`、`/code` 保存正式课堂数据。

1. 在 NAS 控制台创建杭州地域的通用型 NFS 文件系统及 VPC 挂载点，按实际需要选择计费方式。
2. FC 与挂载点使用同一 VPC，配置可访问的交换机和安全组。
3. 将 NAS 挂载至 `/mnt/teaching`，确保函数 UID/GID 对目录有读写权限。
4. 函数最大实例数设为 **1**。本方案的酒店实时事件保存在单进程中，不支持多实例广播。
5. 使用 `SQLITE_JOURNAL_MODE=DELETE`、完整同步和忙等待，避免在网络盘使用 WAL。
6. 正式启用前，在实际 NAS 上验证并发保存、重启恢复与 SQLite 完整性。

NAS 的锁与持久性必须由实际运行环境验证；本地磁盘测试不能替代。若需要多实例水平扩展，
应将数据迁移到托管数据库并引入共享事件发布机制，不应直接提高实例上限。

## 打包与上线

1. 在 FC 控制台导出“函数配置和代码”，私下保存备份；导出文件可能含凭据，不提交 Git。
2. 从官方 Node.js 下载站获取固定版本 `v24.10.0` 的 Linux x64 包，以官方 SHA256 文件核验。
3. 运行 `python3 deploy/package.py --backup <导出.zip> --node <node-linux.tar.xz> --checksums <官方SHASUMS256.txt> --output <部署.zip>`。
   打包保留原已安装 Python 依赖，删除导出中的 Git 元数据、配置和运行数据，仅打包应用所需源文件。
4. 将代码 ZIP 上传至现有函数，启动命令改为 `/bin/bash /code/deploy/bootstrap`，端口保持 9000。
5. 保留原 MCP 的环境变量及 HTTP 触发器。HTTP 方法需允许 GET、POST、PUT、DELETE。
6. 配置存储和最大实例数后部署。`bootstrap` 会验证 NFS 挂载；未挂载时直接拒绝启动，防止误写临时盘。
7. 通过现有 HTTPS 自定义域名访问 `/healthz` 和 `/`，验证两套师生端、真实保存及 MCP `/sse`。
8. 从 NAS 的 `data/bootstrap.json` 安全取得初始教师密码及注册口令。数据库和口令不通过 HTTP 暴露。

原 FC 的临时自定义域名由阿里云管理；正式教学建议配置自己的已备案域名及 HTTPS。
当前代码不自动创建付费资源、不自动改变账号授权，也不记录教师密码到日志。

## 回滚与数据

发生启动或接口故障时，恢复原代码包与原启动命令：

```text
python3 -m uvicorn app:app --host 0.0.0.0 --port 9000
```

回滚代码不删除 NAS 数据。升级前在停止写入后备份完整数据目录；不要直接复制正在写入的 SQLite 文件。
酒店教师端也提供一致性数据库备份下载。定期验证备份可恢复。
