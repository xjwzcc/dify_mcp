# Engineering constraints

- 未经用户明确允许，禁止运行全量测试。
- 修改代码后先通过 `git diff` 确定影响范围，只运行直接相关的测试文件、类、函数或模块。
- 禁止无过滤条件的 pytest、npm test 或其它全量测试命令；不确定影响范围时先询问。
- 最终回复必须列出实际执行的测试命令和未覆盖范围。
- 保持 Node Bridge 复用边界：供应商差异放在 bridge/provider.js；会话与沙箱生命周期属于 agent_demo。
- 不提交 .env、真实 API key、云凭证、用户文件或本机 Codex 配置。
- 不增加宿主进程执行模型命令的 fallback；不能静默关闭沙箱或重放未知外部写操作。
