# Taber 开发计划

## 目标

做一个 Chrome/Edge 侧边栏浏览器 Agent：用户可监督、可中断，能阅读页面、提取文档和图片、跨标签导航、执行受控浏览器自动化，并在侧边栏关闭后继续完成已启动任务。

## 成功标准

MVP 必须跑通 5 条端到端任务：

1. 总结当前网页。
2. 提取页面表格。
3. 跨页收集数据。
4. 填写并提交普通表单。
5. 读取 console/network，解释失败请求。

## 已定架构

```txt
sidepanel           用户监督 UI，展示对话、工具时间线、任务状态
AgentHost           offscreen document，运行 ToolLoopAgent，任务期间懒创建
ChromeApiBroker     background service worker，代理 tabs/scripting/userScripts；debug 构建才代理 debugger
content/userScripts 页面观察、交互和用户同意后的 browserjs 执行
Dexie               单一本地数据源，保存配置、会话、事件日志
```

关键约束：

- 同一时间只运行一个全局 Agent 任务。
- AgentHost 有任务才创建；任务完成后保留 2 分钟，空闲关闭。
- 侧边栏不是状态源；打开时从 Dexie 事件日志重建 UI。
- 上架版安装时只申请必要权限：`storage`、`sidePanel`、`scripting`、`userScripts`、`webNavigation`、`activeTab`、`offscreen`。
- 站点访问走 `activeTab` + `optional_host_permissions`；onboarding 可请求全站授权，拒绝后降级为当前/已授权网站。
- `debugger` 仅在 `TABER_ENABLE_DEBUGGER=1` 的 debug 构建中申请和暴露。
- `browserRepl` 不暴露裸 `chrome.*`。

## 技术栈

- WXT
- Svelte 5
- Svelte AI Elements
- AI SDK v6 `ToolLoopAgent`
- `@ai-sdk/openai-compatible`
- `@webext-core/messaging`
- Dexie
- sandbox iframe

供应商统一配置：`name / baseURL / apiKey / model / contextWindowTokens`。

## 顶层工具

上架版固定 4 个：

1. `getDocument`
2. `extractImage`
3. `navigate`
4. `browserRepl`

debug 构建额外暴露 `debugger`。

## browserRepl API

内置基础 helper：

```txt
observe / query / click / fill / press / scroll / waitFor / sandbox / pickElement
```

用户同意页面脚本后，额外启用 `browserjs`。

执行语义：

- `browserRepl.timeoutMs` 默认 30000，最大 120000。
- 只有显式传参才能加长。
- Stop 按钮通过 `AbortController` 中断。
- `click/fill/press`: 2-5s。
- `waitFor`: 默认 8s。
- `navigate`: 默认 8-15s。
- `observe/query`: 3-5s。
- `sandbox`: 跟随 `browserRepl` 总 timeout。

页面执行：

- 固定 DOM helper 主路径：`chrome.userScripts.execute`，失败后可用隔离 `scripting` fallback。
- `browserjs()` 只在用户同意后出现，使用 `chrome.userScripts.execute({ world: 'MAIN' })` 共享页面 runtime。
- `browserjs()` 像 DevTools Console，不承诺隐藏页面 `fetch` / `XMLHttpRequest` / `WebSocket`。
- `sandbox()` 允许 fetch，用于数据处理和下载。

元素策略：

- `observe()` 默认只返回当前视口元素和页面摘要。
- 预留 `scope: "page"`。
- 模型使用短 `index`。
- 内部保存 `stableId`，执行前校验，避免页面变化后误点。

交互兜底顺序：

```txt
生产版：DOM 操作 → userScripts 事件 → isolated scripting fallback → 明确失败
debug 构建：DOM 操作 → userScripts 事件 → CDP/native fallback
```

## 工具实现切片

### 1. 项目骨架

验证点：

- WXT 能 build Chrome/Edge。
- sidepanel、background、offscreen、sandbox entrypoint 存在。
- Svelte 5 UI 可启动。
- Dexie 初始化成功。

### 2. 本地数据库

实现说明：见 [local-database.md](./local-database.md)。

表：

- `providers`
- `models`
- `sessions`
- `toolRuns`
- `agentEvents`
- `settings`

规则：

- 默认保留最近 30 个 session。
- pinned session 不清理。
- 可设置无限保存。
- 工具结果原样保存到 Dexie。

验证点：

- 创建 session。
- 写入 toolRun/event。
- 侧边栏刷新后重建 UI。
- 超过 30 个后清理旧非 pinned session。

### 3. AgentHost + ChromeApiBroker

实现：

- background 创建/关闭 offscreen AgentHost。
- AgentHost 运行 ToolLoopAgent。
- background 代理 Chrome API。
- sidepanel 订阅 Agent 事件。

验证点：

- 侧边栏关闭后任务继续。
- 重新打开侧边栏能恢复当前任务。
- Stop 能取消 offscreen 中的任务。
- 任务结束后 2 分钟关闭 AgentHost。

### 4. navigate

能力：

- open
- back
- forward
- reload
- listTabs
- switchTab
- closeTab
- currentTab

验证点：

- 当前 tab 打开 URL。
- 新 tab 打开 URL。
- 列出并切换 tab。
- 导航等待不靠 sleep，使用 webNavigation/tabs 事件。

### 5. browserRepl

实现：

- sandbox iframe 执行 REPL 代码。
- runtime provider 暴露 10 个 helper。
- `browserjs()` 通过 userScripts 执行页面脚本。
- Stop 触发 AbortController。

验证点：

- `observe()` 返回可交互元素。
- `click(index)` 成功点击按钮。
- `fill(index, text)` 成功填输入框。
- `waitFor({ text })` 等到页面变化。
- timeout 生效。

### 6. getDocument

工具契约：`source: currentPage | pdf | file`。

第一版范围：

- `currentPage`：`mode: article | page | selection`，读取当前网页正文、全文、选中文本，可包含表格。
- `pdf`：通过 `url` 读取 PDF 文本。
- `file`：读取 UI 已提供的 `fileText`。
- 成功返回 `ok:true` + `content/contentChars/truncated`；可恢复问题返回 `ok:false` + `code/message/retryHint`。
- JSON schema 抽取交给模型二次处理。

验证点：

- 总结网页。
- 提取表格。
- 读取 PDF 文本。

### 7. extractImage

工具契约：`source: viewport | imageElement | canvas | backgroundImage`。

第一版范围：

- `viewport`：`captureVisibleTab` 当前视口截图，不接受 `tabId`。
- `imageElement`：通过 `selector` 提取 `<img>`。
- `canvas`：通过 `selector` 提取 canvas，可用 `format: jpeg` + `jpegQuality: 0..100`。
- `backgroundImage`：通过 `selector` 提取 CSS background image。
- 成功返回 `ok:true`：`viewport/canvas` 带 `dataUrl/mediaType`，`imageElement/backgroundImage` 返回图片 URL 或 data URL 及尺寸元数据。
- 可恢复问题返回 `ok:false` + `code/message/retryHint`，例如元素不存在、selector 非法、截图不可用或页面访问授权不足。
- 暂不做 fullPage 拼接。

验证点：

- 截当前视口。
- 提取商品图片。
- 提取 canvas。

### 8. debugger

上架版不暴露 `debugger` 工具，也不申请 `debugger` 权限。

本地/dev debug 构建通过 `TABER_ENABLE_DEBUGGER=1` 开启；显式脚本 `pnpm run build:chrome:debug` 会产出可校验的 production-mode debug artifact，并镜像到 `.output/chrome-mv3-dev`：

- console logs。
- network logs。
- failed requests。
- main world eval。
- CDP fallback。

不做：

- cookies。

验证点：

- 普通构建 manifest 不含 `debugger`。
- debug 构建 manifest 才含 `debugger`。
- debug 构建可读取 console error、失败请求和页面 runtime 状态。

### 9. UI

方向：Calm precision。

组件：

- Conversation
- Message
- PromptInput
- Tool
- Task
- Plan
- Queue
- Reasoning summary
- Sources
- Context
- WebPreview
- Image
- ModelSelector

不展示原始 chain-of-thought。

主题：

- 默认 follow system。
- 可切换 light/dark/system。

验证点：

- 工具时间线清晰。
- 任务状态清晰。
- 暂停/停止清晰。
- reduced motion 可用。
- 侧边栏窄宽度下不溢出。

## E2E 验证任务

### E2E 1：总结当前网页

步骤：

1. 打开任意文章页。
2. 用户输入“总结这个页面”。
3. Agent 调用 `getDocument({ source: 'currentPage', mode: 'article' })`。
4. 返回摘要和要点。

通过标准：摘要基于页面真实内容，无幻觉。

### E2E 2：提取表格

步骤：

1. 打开含表格页面。
2. 用户要求提取表格为 JSON/Markdown。
3. Agent 调用 `getDocument({ source: 'currentPage', mode: 'page', includeTables: true })`。

通过标准：行列不乱，核心字段完整。

### E2E 3：跨页收集

步骤：

1. 给 3 个 URL。
2. Agent 用 `browserRepl` 循环 `navigate()` + `browserjs()`。
3. 汇总结果。

通过标准：3 页都访问，结果可追溯到 URL。

### E2E 4：填写表单

步骤：

1. 打开测试表单页。
2. Agent `observe()`、`fill()`、`click()`。
3. 提交。

通过标准：字段正确，提交结果可见。

### E2E 5：调试失败请求

步骤：

1. 打开有失败请求的测试页。
2. Agent 调用 `debugger` 读取 network/console。
3. 解释失败原因。

通过标准：能指出失败 URL、状态码/错误、触发上下文。

## 暂不做

- 反检测/隐身自动化。
- cookies 读取。
- reusable site skills。
- Firefox/Safari 兼容。
- fullPage 拼接截图。
- 每窗口/每标签页并发任务。
- 自动脱敏历史。
- 原始 chain-of-thought 展示。
