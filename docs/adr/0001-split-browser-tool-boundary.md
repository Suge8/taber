# 拆分浏览器工具边界

Taber 将浏览器能力拆到顶层工具，而不是把所有扩展能力都暴露给浏览器 REPL。浏览器 REPL 负责页面交互、页面读取和沙箱数据处理；标签页导航归 `navigate`，高权限调试归 `debugger`。REPL 脚本可以调用窄 helper 委托顶层工具，但不能直接访问裸 `chrome.*`。这样模型仍有完整能力，同时避免 REPL 变成无边界的 Extension API bridge。
