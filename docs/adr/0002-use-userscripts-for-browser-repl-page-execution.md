# 使用 userScripts 执行浏览器 REPL 页面脚本

Taber 使用 Chrome `userScripts` 作为浏览器 REPL 的主要页面执行路径。

固定 DOM helper（`observe`、`query`、`click`、`fill`、`press`、`scroll`、`waitFor`、`pickElement`）共享同一份页面 helper 代码，默认在隔离环境执行；`scripting` 只作为固定 helper 的 packaged fallback。

`browserjs` 是用户同意后的高级页面脚本能力，使用 `chrome.userScripts.execute({ world: 'MAIN' })` 运行在页面 runtime。它的语义接近 DevTools Console：可以读取页面 JS 状态，也能看到页面自己的 `fetch`、`XMLHttpRequest` 和 `WebSocket`。Taber 不再维护伪沙箱或源码正则改写来隐藏这些页面能力。

生产版不把任意 `browserjs` fallback 到 `scripting.executeScript({ world: 'MAIN' })` 或 debugger/CDP；`userScripts` 不可用时明确提示用户开启 Allow User Scripts 后重试。debugger/CDP 只属于显式 debug 构建。
