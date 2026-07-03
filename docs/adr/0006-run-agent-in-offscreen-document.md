# 在 offscreen document 中运行 Agent

Taber 使用 offscreen document 作为 AgentHost 来运行 ToolLoopAgent、维护本地任务状态并处理模型流式响应。AgentHost 在有任务时懒创建，在任务结束或取消且无待处理任务后关闭；侧边栏只是 UI 视图，关闭后不应中断用户已启动的任务。MV3 service worker 不适合承载长时间 Agent loop，所以后台 service worker 只作为 ChromeApiBroker，代理 `tabs`、`scripting`、`userScripts` 和 `debugger` 等扩展 API。
