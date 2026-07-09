# 浏览器 Agent 高效执行循环

Taber 的浏览器 Agent 执行策略收敛为：先读最小事实，再选择最短路径，一次动作后验证新状态。`AGENT_INSTRUCTIONS_VERSION` 升到 3。

本次保留既有安全边界，不回退到旧版无边界 REPL。优化点：

- `browser.snapshot` 不再因模型误带 `target` 失败；快照只读取状态，忽略动作字段。
- 无 iframe 的结构化 `browser` 动作在主文档内直接执行并重写返回 refs，避免动作后再注入一次完整快照；有 iframe 时仍走 frame-aware 全局解析，保留跨 frame 歧义保护。
- `browserRepl` 继续作为复杂页面的批处理路径：`readVisibleText/readLinksAndButtons/queryText` 用于快速读运行时状态，`batch/fillForm` 用于确定的多步交互。
- 页面变化等待必须使用自动等待或 `waitFor`，不写 sleep/setTimeout 轮询。
- 账号、订阅、账单任务优先查 Account/Profile/Settings/Subscription，不先点 Upgrade/Edit Payment，降低误触发支付/风控入口的概率。
- 工具运行记录写入 `durationMs`，侧边栏技术详情可直接看到慢工具。

旧版 Taber-Old 的“大 REPL + browserjs”更快但边界弱；Taber 只吸收批处理和站点技能方向，不恢复无约束页面脚本作为默认路径。
