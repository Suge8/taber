# 任务级 target tab 是浏览器 Agent 工作区事实源

状态：已接受；启动与不可操作页失效规则由 ADR 0018 修订。

Taber 在用户发消息启动任务时锁定工作区：background 使用侧边栏所属窗口当时的 active tab，不限制 URL，写入 `runningTask.targetTabId` 与 `task.started.payload.context`。打开侧边栏不锁定 tab，避免用户只是查看侧边栏就改变后续任务起点。

运行中，`runningTask.targetTabId` 是唯一事实源。用户手动切换浏览器 active tab 不改变 Agent 工作区；`navigate.currentTab` 返回 target tab；`getDocument`、`extractImage`、`browser`、`browserRepl`、`debugger` 和 `navigate` 的非切换动作都默认操作 target tab。

允许切换 target 的入口只有三个：

- `navigate.switchTab`：先确认旧 target 仍存在，再切换到目标可操作 tab。
- `navigate.open target:"new"`：在旧 target 所属窗口打开新 tab，并把新 tab 设为 target。
- 侧边栏“改为当前 tab”：用户确认后，由 sidepanel 读取同窗口当前可操作 tab，发送 `taber.agent.switchTarget`。

其他工具显式传入不同 `tabId` 必须失败，错误提示用户用 `navigate.switchTab` 切换工作区，不能跨 target 偷偷执行。

失效处理：target tab 被关闭或不存在时，任务进入 fatal error 并写入 `task.failed`；target 暂时不可操作或权限不足时，仅当前页面工具失败，任务可继续导航恢复。Taber 不回退到其他 active tab，因为那会让 Agent 在用户没确认的页面继续操作。
