# Taber 开发计划

## 目标

做一个强大全能的 Chrome/Edge 侧边栏浏览器 Agent：能阅读页面、提取文档和图片、fetch-first 直接拓取公开 URL、跨标签导航、执行受控浏览器自动化、读写会话文件并沉淀站点技能，并在侧边栏关闭后继续完成已启动任务。

## 成功标准

MVP 必须跑通 5 条端到端任务：

1. 总结当前网页。
2. 提取页面表格。
3. 跨页收集数据。
4. 填写并提交普通表单。
5. 本地 debug 构建读取 console/network，解释失败请求。

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
- 用户发消息启动任务时，background 在侧边栏所属窗口锁定当时可操作的 active http/https tab 为任务工作区；打开侧边栏本身不锁定 tab。
- 运行中用户手动切换浏览器 active tab 不改变工作区；只有 `navigate.switchTab`、`navigate.open target:"new"` 或侧边栏“改为当前 tab”确认后才切换 target。
- target tab 关闭、变成 `chrome://`/`edge://` 等不可操作 URL，或权限不足时任务明确失败，不回退到其他 active tab。
- 所有页面工具默认操作 target tab；显式传入不同 `tabId` 必须失败并提示使用 `navigate.switchTab`。
- 上架版安装时只申请必要权限：`storage`、`sidePanel`、`scripting`、`userScripts`、`webNavigation`、`activeTab`、`offscreen`、`identity`。
- 站点访问走 `optional_host_permissions` 请求 `http/https`；开始浏览器任务前必须完成 Website access 与 User Scripts，拒绝授权时侧边栏保持阻塞；遇到 `chrome://`、`file://` 等不可操作页时明确提示仅支持 `http/https`。
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

上架版固定 6 个：

1. `getDocument`
2. `extractImage`
3. `navigate`
4. `browser`
5. `browserRepl`
6. `fs`

`browser` 是页面操作主路径；`browserRepl` 是高级 fallback；`fs` 是会话文件工作区与站点技能的 ls/read/write（见 ADR 0015/0016）。debug 构建额外暴露 `debugger`。

## browser API

输入：

```txt
action: "snapshot" | "click" | "fill" | "press"
target?: { ref: string } | { role, name } | { label } | { text } | { selector } | { x, y }
value?: string  // fill
key?: string    // press
scope?: "viewport" | "page"  // snapshot state
limit?: number  // snapshot state, max 80
```

执行语义：

- 优先用用户看得懂的 locator：`{ text }`、`{ role, name }`、`{ label }`、`{ ref }`；`{ selector }` 只作为 fallback；`{ x, y }` 是 canvas/纯视觉 UI 的最后手段（viewport CSS px，elementFromPoint 递归 open shadow root，命中 iframe 时明确失败）。
- `PageTarget` 一次只允许一种 locator；`role` 必须和 `name` 成对。
- `snapshot` 返回紧凑语义状态：标题、URL、可见文本摘要、可操作元素的 role/name/state/rect/href/value/ref/hints，以及 `frames[]` 边界；同源 iframe 返回可读摘要，跨域 iframe 只返回 metadata/原因；默认最多 30 个元素，最多 80 个。
- `click/fill/press` 都在动作后等待 DOM 稳定，返回 `ok/evidence/state`；`state` 是最新轻量页面状态，模型不需要手写 observe/wait/observe。
- 多候选、旧 ref、不可见、禁用、不可填写返回 `ok:false`、`code/message` 和可用候选，不误点、不假成功。
- `ref` 是最新 `browser` state 里的短字符串运行时句柄，不是 selector；任意新 state、跨页面、DOM 替换或页面变化后都会失效，必须重新获取状态。

## browserRepl API

内置 helper：

```txt
readVisibleText / readLinksAndButtons / listInteractiveElements / queryText / observe / query / click / fill / press / scroll / waitFor / batch / fillForm / navigate / sandbox / pickElement / pickUserElement
```

用户同意页面脚本后，额外启用 `browserjs`。

执行语义：

- `browserRepl.timeoutMs` 默认 30000，最大 120000；只有显式传参才能加长。
- Stop 按钮通过 `AbortController` 中断；`waitFor`、含 `waitFor` 的 `batch`、`pickUserElement` 走可取消的 isolated scripting 路径。
- 常见页面操作优先走顶层 `browser`；进入 `browserRepl` 后固定 helper 优先用 selector 字符串，`observe/query` 返回的短 `index` 只在同一次 `browserRepl` 调用内有效，跨调用禁止复用。
- 常规策略是一轮快照、一轮 `batch`/`fillForm`、一轮验证；只在导航、失败或页面异常变化后再次 `observe/query`。
- `batch(actions, options?)` 单次执行 `fill/click/press/scroll/waitFor`。默认失败即停；`continueOnError:true` 或 `stopOnError:false` 才继续收集后续步骤错误。
- `fillForm({ fields, confidence?, dryRun? })` 按 label、placeholder、aria-label、name/id/title、邻近文本、section/legend/heading 匹配；只填写高置信且唯一的字段，低置信或多候选进入 `missing/ambiguous`。建议先 dry-run，再执行并检查摘要。
- `navigate(input)` 是窄 helper，委托顶层 `navigate`；`switchTab` 和 `open target:"new"` 会更新任务 target，同一次 `browserRepl` 后续 helper 操作新 target。
- `sandbox()` 用于数据处理和下载，跟随 `browserRepl` 总 timeout。
- 读页面优先用 `readVisibleText()`、`readLinksAndButtons()`、`listInteractiveElements()`、`queryText(text)`；这些固定 helper 不走页面 `AsyncFunction`，可读主 document、open shadow root 与同源 iframe 摘要，并在跨域/不可访问 iframe 边界给出提示。
- `browserjs(codeOrFn, args)` 仅作为用户同意后的高级页面脚本 evidence 能力；页面阅读走 `getDocument`/`browser`/固定 helpers，常见页面动作走顶层 `browser`，导航走 `navigate()`。不承诺完整 JS/DOM 安全沙箱，仍拒绝明显直接 `location/history/window.open` 导航写法，并要求 args/return JSON-like，不能返回 DOM/function/Window/Event/cycle/dataUrl。

页面执行：

- 固定 DOM helper 主路径：`chrome.userScripts.execute`，失败后可用隔离 `scripting` fallback。
- `browserjs()` 只在用户同意后出现，使用 `chrome.userScripts.execute({ world: 'MAIN' })` 共享页面 runtime；`userScripts` 不可用时提示开启 Allow User Scripts，不用生产 debugger/CDP fallback。
- `sandbox()` 允许 fetch，用于数据处理和下载。

元素和视觉策略：

- `readVisibleText()` 返回有字符上限的可见文字；`readLinksAndButtons()`/`listInteractiveElements()` 返回视口优先的结构化可操作元素；`queryText(text)` 返回可见文本上下文和相关候选。
- `observe()` 默认只返回当前视口元素和页面摘要，预留 `scope:"page"`。
- selector 会在主 document 与 open shadow root 中查找；检测到 iframe/frame 时明确提示目标可能在 frame 中，并用 `frames[]` 说明同源可读性与跨域不可读原因。
- 同次调用的 `index/ref` 带临时 marker、结构指纹和可见性校验，避免页面重排、替换或隐藏后误操作。
- 运行中 target tab 注入可见但克制的 overlay：边缘光、badge、动作高亮；视觉失败只 `warn`，不阻断页面动作。任务结束、停止、target 切换或失效时平滑清理。
- `pickUserElement(message?)` 进入用户选择模式，hover 高亮，click 后返回 selector/xpath/text/rect/attributes；Esc、取消或超时返回明确错误且清理捕获层。

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
- `skills`
- `files`（db v3，会话文件工作区，随会话清理）

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

契约：

- `currentTab` 返回当前任务 target，而不是用户临时切到的 active tab。
- `open target:"current"`、`back`、`forward`、`reload` 保持同一个 target tab id。
- `open target:"new"` 在原 target 所属窗口创建新 tab，并把新 tab 设为任务 target。
- `switchTab` 先校验旧 target 仍可操作，再切到目标可操作 tab 并更新 target。
- `listTabs` 只列 http/https 等可操作 tab。

验证点：

- 当前 target 打开 URL。
- 新 tab 打开 URL 并切换任务 target。
- 列出并切换可操作 tab。
- 导航等待不靠 sleep，使用 webNavigation/tabs 事件。
- target 缺失或不可操作时任务失败，不回退 active tab。

### 5. browserRepl

实现：

- sandbox iframe 执行 REPL 代码。
- runtime provider 暴露固定 helper：CSP-safe 页面感知、selector 操作、same-call index、`batch`、`fillForm`、`navigate`、picker 和 `sandbox`。
- `browserjs()` 通过 userScripts 执行页面脚本，只作为同意后的高级序列化 evidence 能力。
- Stop 触发 AbortController，并把可取消页面命令传到页面 runtime。

验证点：

- `observe()` / `query()` 返回可交互元素，index 只在同一次调用内有效。
- `click/fill/press(selector)` 或 same-call index 成功操作元素，跨调用 index 明确失败。
- `batch()` 默认 stopOnError，返回每步 selector、动作结果和稳定后的 evidence。
- `fillForm()` dry-run、唯一匹配、missing/ambiguous 和动态字段 evidence 正确。
- `pickUserElement()` 可返回 selector/xpath/rect/attributes，并能取消清理。
- `waitFor({ text })` 等到页面变化，timeout 生效。
- `browserjs()` 返回 bounded console/stack evidence，拒绝不可序列化结果和明显直接导航。

### 6. getDocument

工具契约：`source: currentPage | url | file`。

范围：

- `currentPage`：`mode: article | page | selection`，读取当前网页正文、全文、选中文本，可包含表格；open shadow root 会并入可读 DOM，`frames[]` 标明 iframe 可读性，同源 iframe 文本只放在对应 frame 条目下，跨域 iframe 只列 metadata/原因。
- `url`：fetch-first，不开 tab 直接拓取 http/https 网页或 PDF（content-type 自动分流）；失败时明确引导回退 navigate + currentPage（见 ADR 0017）。
- `file`：按名读取 `/workspace` 文件（pdf/docx/文本）为文本。
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
- network logs / failed requests，可用 `diagnostics` 一次取回。
- Accessibility/AX snapshot，用于普通 semantic snapshot 不足时诊断复杂组件。
- main world eval。
- CDP/native click、type、press fallback；顶层 `browser` DOM action 失败时仅 debug 构建会尝试，并在输出中标明 fallback。

不做：

- cookies。

验证点：

- 普通构建 manifest 不含 `debugger`。
- debug 构建 manifest 才含 `debugger`。
- debug 构建可读取 console error、失败请求、AX snapshot 和页面 runtime 状态。

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

- 受控页胶囊显示 title/domain/favicon/tabId/windowId，运行中显示 “Taber is controlling this page/Taber 正在控制此页”。
- 运行中“改为当前 tab”必须先确认，成功后写入 `task.targetChanged` 并更新胶囊，不插入主时间线。
- 页面 overlay 和动作高亮能注入、reload 后重注入、任务结束后平滑清理，且 overlay 根节点 `pointer-events:none`。
- 工具时间线清晰，只展示已脱敏/截断的输入与返回面板，不再显示重复的原始详情面板。
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
2. Agent 用 `navigate()` helper/顶层工具逐页访问。
3. 每页优先用 `readVisibleText()`/`queryText()` 读取短小、可序列化的标题/URL/正文 evidence，或用 `getDocument` 读取正文。
4. 汇总结果。

通过标准：3 页都访问，结果可追溯到 URL；不通过 `browserjs` 直接改 location/history 导航。

### E2E 4：填写表单

步骤：

1. 打开测试表单页。
2. Agent 用 `fillForm({ dryRun:true })` 预检字段匹配。
3. Agent 用 `fillForm()` 批量填写，再用 `batch([{ action:"click", selector:"..." }, { action:"waitFor", ... }])` 提交并验证。

通过标准：字段正确，missing/ambiguous 为空，提交结果可见。

### E2E 5：调试失败请求（本地 debug 构建）

步骤：

1. 打开有失败请求的测试页。
2. 本地 debug 构建中的 Agent 调用 `debugger` 读取 network/console。
3. 解释失败原因。

通过标准：能指出失败 URL、状态码/错误、触发上下文。

## 暂不做

- 反检测/隐身自动化。
- cookies 读取。
- Firefox/Safari 兼容。
- fullPage 拼接截图。
- 每窗口/每标签页并发任务。
- 自动脱敏历史。
- 原始 chain-of-thought 展示。
