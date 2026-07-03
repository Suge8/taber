# debugger 只在 debug 构建可用

Taber 不再默认保持 `debugger` 工具可用。`debugger` 权限会触发高风险权限提示，也会扩大 Chrome Web Store 审核面；上架版的核心浏览器 Agent 能力应依赖普通固定工具、`activeTab`、optional host permissions、`scripting` 和 `userScripts`。

生产构建：

- manifest 不申请 `debugger`。
- Agent 工具列表不暴露 `debugger`。
- `click` / `fill` / `press` 失败后不走 CDP/native fallback，而是给出清楚失败。
- `browserjs` 不可用时提示开启 Allow User Scripts，不 fallback 到 debugger/CDP。

本地/dev debug 构建：

- 使用 `TABER_ENABLE_DEBUGGER=1` 开启。
- manifest 包含 `debugger`。
- Agent 可使用 `debugger` 工具和 CDP/native fallback。

这样保留排障能力，但不把高权限调试混入上架版默认体验。
