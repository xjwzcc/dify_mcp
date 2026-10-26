# Reused ModelHub Bridge

本目录从现有系统的 Node Bridge 抽出，保留协议路由、工具转换、native input 处理及签名 scope 模块。源码中的 ModelHub 函数名和 `expserver-codex` HMAC namespace 为兼容性保留，不表示依赖原系统服务。

新增 `provider.js`，把上游地址/鉴权/envelope 隔离出来。DeepSeek 模式使用原生 Responses API；不重新实现 Chat Completions → Responses 引擎。控制服务只开放受 attempt 鉴权的 `/v1/responses`，Bridge 本身只监听127.0.0.1。

针对当前部署的调整：

- 明文 reasoning/call_id 保留；不支持的 opaque history 明确拒绝。
- DeepSeek 模式关闭 response 内存缓存和远程 compact，不依赖多实例间共享 native history。
- completed/incomplete/failed 终止事件识别；不完整流返回错误。
- 上游180秒超时、事件大小限制、输出预算上限、payload 日志默认关闭。
- 默认地址已替换为公开 DeepSeek URL；无内网 endpoint、API key 或原项目环境文件。

`UPSTREAM_PROVIDER=modelhub` 保留旧 envelope 以便后续复用。当前 Python 启动器固定配置 DeepSeek，旧三种客户端协议和 ModelHub 上游没有在本次云环境验收。不要把 Bridge 的历史兼容功能当成业务持久化。
