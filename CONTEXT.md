# Taber

Taber 是一个可见、可控的浏览器 Agent。它从浏览器侧边栏帮助用户阅读网页、理解页面状态并执行浏览器操作；用户能看到过程并随时中断。

## 语言

**浏览器 Agent**:
一个用户可见的助手，读取并操作浏览器页面，过程公开、用户可随时中断。
_Avoid_: 隐身 Agent、反检测 Agent、绕风控工具

**礼貌操作节奏**:
让浏览器操作更易读、更稳定、更容易被用户中断的自然节奏。
_Avoid_: 真人伪装、机器人检测绕过、隐身行为

**可见可中断**:
浏览器 Agent 默认可直接执行动作，用户通过暂停或停止来介入；系统不对每一步做审批。
_Avoid_: 逐步审批、默认拦截

**浏览器 REPL**:
一个受控代码执行工具，用来做页面交互、页面读取和数据处理；跨标签导航和高权限调试由独立顶层工具承担。
_Avoid_: 万能 REPL、未分边界的 Extension API bridge

**REPL 内置 API**:
浏览器 REPL 中提供给 Agent 使用的少量稳定 helper：`observe`、`query`、`click`、`fill`、`press`、`scroll`、`waitFor`、`sandbox`、`pickElement`；用户同意页面脚本后再启用 `browserjs`。
_Avoid_: 冗余 helper、裸 Chrome API、重复导航实现、未经同意的页面脚本执行

**浏览器 REPL page runtime**:
浏览器 REPL 注入页面后执行固定 DOM helper 的单一页面语义源；固定 helper 默认在隔离环境运行。`browserjs` 是用户同意后才可用的高级页面脚本能力，运行在页面 `MAIN` runtime，语义接近 DevTools Console，不承诺隐藏页面 `fetch`、`XMLHttpRequest` 或 `WebSocket`。
_Avoid_: 后台复制 DOM helper、多套元素稳定性规则、把 `browserjs` 伪装成安全沙箱

**本地 Agent 数据库**:
浏览器 Agent 的单一本地数据源，保存供应商配置、模型配置、会话、消息和工具运行记录。
_Avoid_: 分裂配置存储、多事实源

**本地 Agent 数据库配置流程**:
围绕本地 Agent 数据库的事务型配置用例，统一写入模型供应商、凭证、模型和默认选择，保证这些配置不变量不分散到设置页。
_Avoid_: UI 逐步拼装数据库写入、重复 selected model 回退逻辑

**AgentHost**:
运行浏览器 Agent 主循环的隐藏扩展页面。它在有任务时懒创建，在任务结束或取消且无待处理任务后关闭；侧边栏关闭后仍继续执行用户已启动的任务，并通过后台代理调用浏览器扩展 API。
_Avoid_: 常驻后台 daemon、侧边栏 Agent、service worker Agent

**ChromeApiBroker**:
后台 service worker 中的浏览器 API 代理，代表 AgentHost 执行标签页、脚本注入和 userScripts 等扩展能力；`debugger` 只在显式 debug 构建中开放。
_Avoid_: 在 AgentHost 中直接调用 Chrome API、重复 API bridge、上架版默认暴露高权限调试能力

**Agent 事件日志**:
浏览器 Agent 运行过程的持久记录，包含消息、工具调用、工具结果和任务状态变化；侧边栏通过读取并订阅它恢复 UI。
_Avoid_: UI 内存状态、仅实时事件

**Agent 事件日志投影**:
从 Agent 事件日志派生 task 分组、对话、工具时间线、来源、图片和模型上下文安全证据的单一解释入口；侧边栏和模型上下文只消费该投影，不各自重建事件语义。
_Avoid_: 分散 task 状态判断、重复解析工具事件、泄露 `<think>` / reasoning 原文

**全局 Agent 任务**:
Taber 同一时间只运行一个浏览器 Agent 任务；新任务必须等当前任务结束、取消或停止后才能开始。
_Avoid_: 每窗口并发任务、每标签页并发任务

**Browser Access onboarding**:
独立于模型配置的首次访问引导，用来说明站点访问、页面脚本执行和 Chrome Allow User Scripts 状态；开始浏览器任务前必须完成 Website access 与 User Scripts，拒绝授权时侧边栏保持阻塞，遇到 `chrome://`、`file://` 等不可操作页时明确提示仅支持 `http/https`。
_Avoid_: 把浏览器权限埋进模型 onboarding、静默拿全网权限、暗示可跳过授权继续浏览器任务

**调试工具**:
高权限浏览器工具，用来读取 console/network、执行 main world 脚本和调用 CDP；仅在 `TABER_ENABLE_DEBUGGER=1` 的本地/dev debug 构建中暴露，上架版不申请 `debugger` 权限。
_Avoid_: 上架版默认调试工具、隐藏的 CDP fallback、把 debugger 当普通页面操作

**文档提取**:
将网页、选区、PDF 和用户文件转换为 Agent 可读的 Markdown、纯文本或结构化内容的能力。
_Avoid_: 仅 DOM 文本、重型通用解析平台

**文档提取 DOM Markdown**:
AgentHost 侧把网页 DOM/HTML 快照统一转换为 Markdown 和表格，页面注入只负责读取快照。
_Avoid_: 页面注入内重复 Markdown 规则、多套表格解析

**视觉提取**:
获取当前视口截图、页面图片、canvas 和 background image 等视觉材料，供 Agent 判断页面视觉状态或提取图片信息。
_Avoid_: 第一版 fullPage 拼接截图、仅 DOM 视觉推断

**Agent 控制侧边栏**:
用户观看、输入、暂停、停止和恢复浏览器 Agent 的主界面；它展示对话、工具时间线、任务状态和当前浏览器上下文。
_Avoid_: 纯聊天框、开发者工具式 REPL 主界面

**工具时间线**:
按执行顺序展示 Agent 的计划、工具调用、工具结果、错误和恢复动作的 UI 投影，用来让用户理解 Agent 正在做什么。
_Avoid_: 隐藏工具过程、只显示最终回答
