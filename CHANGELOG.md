# Changelog

<p align="center">
  <a href="#english">🇺🇸 English</a> · <a href="#中文">🇨🇳 中文</a>
</p>

## Unreleased - 2026-07-13

### English

#### Changed

- Localized the extension description for English and Simplified Chinese browser interfaces.

### 中文

#### 变更

- 扩展描述现已适配英文和简体中文浏览器界面。

## 0.5.1 - 2026-07-13

### English

#### Changed

- Canonicalized model tool inputs so task targets, browser execution timeouts, and runtime-only fields remain host-owned; irrelevant placeholder fields are discarded before execution.
- Hardened Browser REPL lifecycle management with one total budget, cancellation propagation to in-flight page commands, remaining-budget caps for helpers, and explicit `NO_EVIDENCE` results.
- Navigation failures now return recoverable error contracts with retry guidance, while side-panel presentation distinguishes recoverable failures from task failures.

#### Diagnostics

- Added `runtime.configured` session diagnostics for non-secret provider/model metadata, reasoning effort, and tool schema version.

#### Documentation

- Documented canonical tool input boundaries and the limited Chrome offscreen runtime API.

### 中文

#### 变更

- 规范化模型工具输入：目标标签页、浏览器执行超时和运行时字段由宿主持有，模型填入的无关占位字段会在执行前丢弃。
- 加固 Browser REPL 生命周期：统一总预算、取消传播到在途页面命令、按剩余预算限制 helper，并在没有证据时明确返回 `NO_EVIDENCE`。
- 导航失败改为带重试建议的可恢复错误契约；侧边栏区分可恢复工具失败与任务失败。

#### 诊断

- 新增 `runtime.configured` 会话诊断事件，记录非秘密的 provider/model 元数据、推理强度和工具 Schema 版本。

#### 文档

- 补充模型工具输入边界及 Chrome offscreen 受限 runtime API 说明。

## 0.5.0 - 2026-07-12

### English

#### Highlights

- Added an optional Follow AI actions mode. It activates the controlled target tab before page operations so users can watch the Agent work, without bringing the Chrome window to the front. Background mode remains the default.
- The selected mode is persisted locally and captured when a task starts, so a running task keeps one consistent execution policy.

#### Changed

- Foreground mode applies consistently to page reading, image extraction, browser control, Browser REPL, debug tools, and navigation. `navigate.open target:"new"` and `navigate.switchTab` follow the task mode.
- Background viewport capture still activates the target only when Chrome requires it, then restores the previous tab when the user has not switched tabs during capture.
- The obsolete `active` navigation input is rejected; tab activation is controlled by the task mode instead of model-generated input.

#### Security

- Runtime side-panel smoke tests verify the isolated build marker before clearing extension data or changing site permissions, preventing a test run from modifying an unrelated installed Taber.

### 中文

#### 重点

- 新增可选的“跟随 AI 操作”模式。页面工具执行前会激活受控目标标签页，方便用户观看 Agent 操作，但不会把 Chrome 窗口抢到操作系统前台；默认仍为后台模式。
- 模式偏好保存在本地，并在任务启动时固定，运行中的任务始终使用同一执行策略。

#### 变更

- 前台模式统一应用于页面读取、图片提取、浏览器控制、Browser REPL、调试工具和导航；`navigate.open target:"new"` 与 `navigate.switchTab` 也遵循任务模式。
- 后台 viewport 截图仍会在 Chrome 必须激活标签页时临时激活目标；如果用户期间没有切换标签页，截图后会恢复原标签页。
- 废弃的 `active` 导航输入会被拒绝；标签激活由任务模式控制，不再由模型输入决定。

#### 安全

- 侧边栏运行时烟测会先校验本次隔离构建标记，再清空扩展数据或修改站点权限，避免测试误操作用户已安装的其他 Taber。

## 0.4.1 - 2026-07-10

### English

#### Fixed

- Browser Control centers the permission guide after the settings dialog enters, keeps the full spotlight visible, and returns to the top after authorization. Reduced-motion mode positions it immediately.
- Activity group labels and colors follow the latest or terminal outcome. Recovered and completed groups use the success tone; failed steps remain visible in details.

#### Changed

- The Sources card uses one edge-to-edge hover surface with reversible motion and a subtle icon lift. Its popover opens directly into source items without a repeated heading.
- Browser ref guidance, schemas, and runtime tests match the implemented lifecycle: refs survive snapshots and ordinary DOM updates while the same target stays visible and unchanged.

#### Performance

- AgentHost loads browser tools and provider-specific model runtimes when a task needs them, reducing the initial offscreen entry from 629 kB to 361 kB.
- Release verification enforces a 500 kB initial-entry budget for AgentHost and the side panel.

#### Documentation

- README adds lossless product screenshots for the idle side panel, completed tasks, and site skills.

### 中文

#### 修复

- 浏览器控制在设置弹窗进场后将权限引导完整移至可视区域中央，授权完成后回到顶部。减少动态效果模式会立即定位。
- 活动组文案和颜色跟随最新步骤或整轮终态。恢复成功和已完成状态使用成功色，失败步骤仍保留在详情中。

#### 变更

- 来源卡片使用覆盖整张卡片的单一 hover 表面，并统一进出过渡与图标微动效。气泡直接展示来源条目，不再重复标题。
- 浏览器 ref 文案、Schema 和运行时测试与实际生命周期对齐：同一目标保持可见且未变化时，ref 可跨快照和普通 DOM 更新继续使用。

#### 性能

- AgentHost 仅在任务需要时加载浏览器工具和对应供应商模型运行时，offscreen 初始入口由 629 kB 降至 361 kB。
- 发布校验对 AgentHost 和侧边栏初始入口执行 500 kB 体积预算。

#### 文档

- README 增加空闲侧边栏、任务结果和站点技能的无损产品截图。

## 0.4.0 - 2026-07-10

### English

#### Highlights

- Rebuilt the side-panel timeline around compact activity groups that combine reasoning and tool work without hiding execution evidence.
- Hardened long-running Agent tasks with bounded steps, per-step and total timeouts, stream health checks, and explicit terminal failures.
- Expanded builtin site skills from 8 to 27, organized into ticketing, shopping, social, video, travel, developer, and reference categories.
- Added GPT-5.6 Sol, Terra, and Luna support across OpenAI-compatible and ChatGPT/Codex flows.
- Decoupled task startup from page access: pure Q&A can begin on new-tab or restricted pages, then navigate to an operable page.
- Added exportable session diagnostics so persisted Agent behavior can be inspected without reproducing the task.

#### Added

- Activity groups with running, completed, failed, stopped, and recoverable-warning states; each group reports step count and elapsed duration.
- Expandable activity details for every reasoning and tool step, including copyable raw tool input, output, and error evidence.
- Activity auto-follow: opening a group jumps to the newest step, follows live additions, pauses when the user scrolls up, and resumes near the bottom.
- One-line JSONL session export from Settings → Preferences → Diagnostics. Strings over 2,048 characters and screenshot data URLs are truncated to reviewable previews.
- `scripts/dump-session-events.ts` for listing and exporting sessions from a CDP-reachable Taber instance, plus `docs/debugging.md` with event signatures and failure diagnosis.
- Stream guards for malformed tool JSON, content after complete JSON, mismatched delimiters, oversized tool input, oversized step output, and degenerate whitespace runs.
- A 180-second stream idle timeout, 5-minute per-step timeout, 30-minute task timeout, and explicit 20-step tool-loop ceiling.
- Seven localized skill categories with per-skill and per-category enable controls; custom user/Agent skills remain a separate first-class group.
- Nineteen new builtin skills for Tixbay, Damai, Ticketmaster, StubHub, Amazon, Taobao, JD, eBay, X, Xiaohongshu, Weibo, Zhihu, Instagram, YouTube, Bilibili, Douyin, TikTok, Booking.com, and Airbnb.
- Chinese names and descriptions for all 27 builtin skills, while stored skill identifiers remain stable.
- Prompt-based skill pre-matching: tasks can discover a site skill from a site name in the request before the first navigation.
- GPT-5.6 Sol, Terra, and Luna presets with 1,050,000-token context windows; OpenRouter also includes `openai/gpt-5.6-sol`.
- Weekly staleness checks for the cached models.dev catalog, refreshed in the background from provider settings.
- ADR 0018 documenting task startup and recovery from non-operable target tabs.

#### Changed

- Consecutive reasoning and tool events now render as one activity block; assistant text splits blocks and keeps the original event order.
- Cancelled tasks render as stopped rather than looking active; recoverable tool results render as warnings instead of false success or fatal failure.
- Live side-panel events insert by event ID and deduplicate; session snapshots also read Agent events by ID rather than wall-clock timestamps.
- Quick actions use a stable Summarize, Skills, Research, Compare order instead of guessing intent from the current URL or page title.
- The Skills panel groups builtins by category, exposes localized metadata, supports whole-group toggles, and keeps custom skills visible for discovery.
- Matching skills are mandatory prior reading. Tasks that need at least four exploratory tool calls to discover a reusable route must save or update a skill before finishing.
- Builtin skills seed before the side panel becomes ready, so the Skills panel is populated before the first Agent task creates an offscreen host.
- Tasks lock any active tab that exists, including `chrome://`, `edge://`, and new-tab pages; page-access failures remain recoverable while missing or closed targets remain fatal.
- Page tools operate on the locked target in the background without activating it on every call.
- `navigate.switchTab` changes the task target without stealing focus; `navigate.open target:"new"` opens in the background unless `active:true` is requested.
- Viewport screenshots temporarily activate the target because Chrome only captures the visible tab, then restore the prior tab only if the user did not switch during capture.
- Navigation load timeouts return `navigation.status:"timeout"` with inspectable tab state. Superseded `net::ERR_ABORTED` navigations keep waiting for the replacement navigation.
- Browser refs survive the immediately preceding routed snapshot and ordinary page mutations while marker, visibility, frame URL, tag, and fingerprint checks still reject changed targets.
- Structured browser target parsing drops empty placeholder fields, prefers an explicit snapshot ref over echoed semantic fields, and lets semantic locators outrank placeholder coordinates.
- `getDocument` and `extractImage` ignore irrelevant padded fields from model-generated tool input while preserving required-field and value validation.
- Model lists sort newer numeric generations first, then provider priority; subscription model chips can expand from the preview to the full list.
- Codex OAuth, model discovery, and inference identify as official `codex_cli_rs` client `0.144.1`, including the inference version header required by gated models.
- OpenAI and Codex requests ask for detailed reasoning summaries only on models that declare reasoning support; non-reasoning models receive no reasoning fields.
- Side-panel icons now use the existing Lucide package throughout. The unused `phosphor-svelte` production dependency was removed.
- Settings, provider onboarding, session history, composer, sources, files, toasts, and subscription cards share one motion and interaction system with reduced-motion fallback.
- Session history positions the current item below its sticky action row and uses bidirectional view transitions for old, new, and rapidly switched sessions.

#### Fixed

- Streaming text, reasoning, and tool-input deltas flush at 512 characters or within 300 ms, reducing IndexedDB transactions without waiting for another delta.
- Buffered event types and IDs flush in sequence before lifecycle events, preserving the exact persisted and live event order.
- Out-of-order runtime broadcasts no longer disappear, and duplicate broadcasts no longer create duplicate timeline parts.
- Invalid model tool input now creates a persisted `tool.failed` event instead of leaving the activity permanently pending.
- Active partial tool inputs receive failure events when a stream health guard stops generation.
- A stream ending at the tool-loop limit now fails with a narrow-task retry message instead of reporting an empty or successful response.
- Internal timeout aborts are distinguished from user cancellation and reported as execution timeouts.
- Provider errors retain up to 600 characters of upstream response context after credential redaction, preserving messages such as “Model not found.”
- Remote document fetches stop after 30 seconds and retain HTTP, CORS, timeout, or network reasons in recoverable results.
- Page-access and screenshot failures retain the browser’s original reason alongside Browser Control guidance.
- Explicit mismatched `tabId` values fail before browser access in `getDocument`, all `extractImage` sources including viewport, `browser`, `browserRepl`, debug-only `debugger`, and every non-switch navigation action.
- The background broker and navigate controller enforce the same target boundary, so direct internal calls cannot bypass Agent runtime validation.
- A user tab switch before or during viewport capture rejects the screenshot and never restores focus over the user’s newer selection.
- Non-operable targets no longer trigger fatal task cancellation; only a closed or missing target ends the task, with no fallback to another active tab.
- Navigation no longer activates the target for open, back, forward, reload, current-tab reads, debugger calls, or page-tool validation.
- `fs read` trims accidental model output after a `.md` skill path instead of turning a valid skill lookup into a not-found error.
- Session switching rejects stale async reads, so rapid History → New Session actions cannot be overwritten by an older request.
- Stopped and completed activity groups no longer retain running beam or breathing effects.
- Skill reads and writes use a distinct “site skill” label instead of appearing as generic file operations.
- Side-panel runtime smoke now handles Chrome 150 API namespaces, CSS-transformed labels, icon-only controls, and short history lists without weakening user-facing assertions.

#### Security

- Only `navigate.switchTab`, `navigate.open target:"new"`, or explicit side-panel confirmation may retarget a task; all other cross-target IDs fail with a recovery instruction.
- Starting from a restricted page does not widen host permissions or page access. Page tools fail explicitly until navigation reaches an allowed page.
- Release builds still omit `debugger` and cookies permissions. Detailed reasoning uses provider summaries and does not expose raw chain-of-thought.

### 中文

#### 重点

- 侧边栏时间线改为紧凑活动组，把 reasoning 与工具过程收进同一条执行轨迹，同时保留完整证据。
- Agent 长任务新增步数、单步/总时长、流健康检查和明确终止错误，不再无限生成或假完成。
- 内置站点技能从 8 个扩展到 27 个，按票务、购物、社交、视频、旅行、开发和知识七类管理。
- OpenAI-compatible 与 ChatGPT/Codex 流程新增 GPT-5.6 Sol、Terra、Luna 支持。
- 任务启动与页面访问解耦：可从新标签页或受限页面开始纯问答，再导航到可操作页面。
- 新增可导出的会话诊断，不必复现任务即可检查已持久化的 Agent 行为。

#### 新增

- 活动组支持运行、完成、失败、停止和可恢复警告五种状态，显示步骤数与执行时长。
- 每个 reasoning 和工具步骤均可展开，保留可复制的原始工具输入、输出与错误证据。
- 活动自动跟随：展开后跳到最新步骤；实时追加时持续跟随；用户上翻后暂停，回到底部恢复。
- 设置 → 偏好 → 诊断新增 JSONL 会话导出。超过 2,048 字符的字符串和截图 data URL 会截成可审阅预览。
- 新增 `scripts/dump-session-events.ts`，可从支持 CDP 的 Taber 实例列出并导出会话；`docs/debugging.md` 记录事件特征和故障判读。
- 流守护覆盖非法工具 JSON、完整 JSON 后续写、括号不匹配、超大工具入参、超大单步输出和退化空白输出。
- 新增 180 秒流空闲超时、5 分钟单步超时、30 分钟任务超时和明确的 20-step 工具循环上限。
- 新增七类本地化技能分组与单技能/整组开关；用户和 Agent 自建技能保留独立的自定义分组。
- 新增 19 个内置技能：Tixbay、大麦、Ticketmaster、StubHub、Amazon、淘宝、京东、eBay、X、小红书、微博、知乎、Instagram、YouTube、B站、抖音、TikTok、Booking.com、Airbnb。
- 27 个内置技能全部补齐中文名称和描述，存储层技能标识保持稳定。
- 新增 prompt 预匹配：用户请求中出现站名时，首次导航前即可发现对应技能。
- 新增 GPT-5.6 Sol、Terra、Luna 预设，context window 为 1,050,000 tokens；OpenRouter 同步加入 `openai/gpt-5.6-sol`。
- models.dev 缓存每周检查时效，在供应商设置中后台刷新新模型和 context window。
- 新增 ADR 0018，记录不可操作 target tab 的任务启动与恢复语义。

#### 变更

- 连续 reasoning 和工具事件合并为活动块；assistant 文本负责分隔活动块，原始事件顺序不变。
- 已取消任务显示为停止；可恢复工具结果显示为警告，不再伪装成功或误报 fatal。
- 侧边栏实时事件按 ID 插入并去重；会话快照也按事件 ID 而不是本地时间排序。
- 快捷操作固定为总结、技能、调研、比价，不再根据当前 URL 或标题猜测并重排。
- 技能面板按类别展示内置技能，显示本地化元数据，支持整组开关，并固定展示自定义技能入口。
- 匹配到技能后必须先读；若任务至少花 4 次探索性工具调用才找到可复用路径，结束前必须新增或更新技能。
- 侧边栏完成初始化前先写入内置技能，首次 Agent 任务尚未创建 offscreen host 时技能面板也有完整内容。
- 任务锁定任何存在的 active tab，包括 `chrome://`、`edge://` 和新标签页；页面访问失败可恢复，target 缺失或关闭才 fatal。
- 页面工具直接操作锁定的后台 target，不再每次调用都激活标签页。
- `navigate.switchTab` 切换任务 target 时不抢焦点；`navigate.open target:"new"` 默认后台打开，只有 `active:true` 才激活。
- Chrome 只能截可见标签页，因此 viewport 截图会临时激活 target；仅当用户没有切走时才恢复之前的标签页。
- 页面 load 超时返回可检查的 `navigation.status:"timeout"`；被后续导航替代的 `net::ERR_ABORTED` 继续等待新导航。
- browser ref 可跨最近一次 routed snapshot 和普通页面变动继续使用；marker、可见性、frame URL、tag 与 fingerprint 仍负责拒绝真实失效目标。
- browser target 解析会丢弃空占位字段，优先采用显式 snapshot ref，并让语义定位优先于占位坐标。
- `getDocument` 与 `extractImage` 忽略模型补齐的无关字段，同时继续校验必填字段和字段值。
- 模型列表先按数字版本从新到旧排序，再按供应商 priority；订阅模型 chip 可从预览展开为完整列表。
- Codex OAuth、模型发现和推理统一使用官方 `codex_cli_rs`、客户端版本 `0.144.1`，推理请求携带 gated model 所需 version header。
- OpenAI/Codex 仅对声明支持 reasoning 的模型请求 detailed reasoning summary；非 reasoning 模型不再收到 reasoning 字段。
- 侧边栏图标统一复用已有 Lucide 包，删除未使用的 `phosphor-svelte` 生产依赖。
- 设置、供应商引导、会话历史、输入区、来源、文件、toast 和订阅卡统一动效与交互规则，并支持 reduced motion。
- 会话历史会把当前项定位到 sticky 操作区下方；旧会话、新会话和快速切换使用双向视图过渡。

#### 修复

- 文本、reasoning 和工具入参 delta 达到 512 字符或最迟 300 ms 刷新，减少 IndexedDB 事务且不依赖下一段 delta。
- 不同事件类型和 ID 在生命周期事件前按顺序 flush，保证持久化事件与实时事件顺序一致。
- 乱序 runtime broadcast 不再丢失，重复 broadcast 不再生成重复时间线节点。
- 模型生成的非法工具入参会持久化 `tool.failed`，不再让活动永久停在 pending。
- 流健康守护中止生成时，会给仍未完成的工具入参写入失败事件。
- 工具循环达到上限却没有最终回复时明确失败，并提示缩小任务范围，不再返回空结果或假成功。
- 内部超时 abort 与用户主动取消分开表达，内部超时会报告执行超时。
- 供应商错误在凭证脱敏后保留最多 600 字符上游响应，`Model not found` 等事实可直接诊断。
- 远程文档 fetch 最长 30 秒，并在可恢复结果中保留 HTTP、CORS、timeout 或网络失败原因。
- 页面访问与截图失败同时保留浏览器原始原因和 Browser Control 操作指引。
- `getDocument`、全部 `extractImage` source（含 viewport）、`browser`、`browserRepl`、debug-only `debugger` 和所有非切换导航动作都会在访问浏览器前拒绝错误 `tabId`。
- background broker 与 navigate controller 同步执行 target 边界，内部直接调用也不能绕过 Agent runtime 校验。
- 用户在 viewport 截图前或截图中切 tab 时会拒绝截图，也不会把焦点恢复到用户的新选择之上。
- 不可操作 target 不再触发任务 fatal；只有 target 关闭或不存在才结束任务，且绝不回退到其他 active tab。
- open、back、forward、reload、current-tab 读取、debugger 和页面工具校验不再激活 target。
- `fs read` 会截掉 `.md` 技能路径后模型误带的垃圾字符，避免有效技能被误报不存在。
- 会话切换会拒绝过期异步读取，快速执行“历史会话 → 新会话”时不会被旧请求覆盖。
- 已停止和已完成活动组不再残留运行中的 beam 或呼吸效果。
- 技能读写显示独立的“站点技能”标签，不再混为普通文件操作。
- 侧边栏 runtime smoke 兼容 Chrome 150 API namespace、CSS 文案变换、纯图标控件和短会话列表，同时保留用户行为断言。

#### 安全

- 只有 `navigate.switchTab`、`navigate.open target:"new"` 或侧边栏明确确认可以切换任务 target；其他跨 target ID 全部失败并给出恢复指引。
- 从受限页面启动任务不会扩大 host permission 或页面访问能力；导航到获准页面前，页面工具会明确失败。
- 发布构建继续排除 `debugger` 和 cookies 权限；detailed reasoning 使用供应商 summary，不展示原始 chain-of-thought。

## 0.3.0 - 2026-07-09

### English

#### Highlights

- Added the `fs` tool: a virtual file system exposing a per-session `/workspace` file area and the `/skills` site-skill library through one `ls`/`read`/`write` surface.
- Added the site skills system: reusable, agent-authored site knowledge with lazy disclosure, host-change announcements, builtin seeds for 8 major sites, and a freshness loop.
- Added fetch-first URL reading: `getDocument source:"url"` fetches public webpages and PDFs directly without opening a tab, making cross-page collection parallel.
- Added a document workflow: upload PDF/Word/text files, generate Markdown/HTML/CSV/Word from tasks, download from the side panel, and export Markdown/HTML to PDF via the browser print dialog.
- Added context economy: oversized document and REPL outputs are saved to `/workspace` and only a preview plus a stable file path enters the model context and event log.

#### Added

- `fs` tool (`ls`/`read`/`write`): `/workspace/<name>` holds session uploads and outputs; `/skills/<slug>.md` exposes site skills as frontmatter Markdown files, matching the file-system prior LLMs are trained on.
- File workspace: writing `.md`/`.txt`/`.html`/`.csv`/`.json` stores text; writing `.docx` converts Markdown to Word (`docx`, dynamically imported); uploaded `.docx`/`.pdf`/text files are readable as text through `getDocument source:"file"` (mammoth/pdfjs).
- Side panel file UI: paperclip upload in the composer (with attachment chips and prompt annotation), a files strip with download, delete, and Export PDF actions, and a dedicated print page (`print.html`, marked + DOMPurify) for high-quality PDF export via the browser print dialog.
- Site skills: task instructions carry a digest of skills matching the current site; `navigate` (all actions), `browser`, and `browserRepl` announce `availableSkills` whenever an action lands on a new host, and never repeat on the same host.
- Skill authoring loop: the agent saves non-obvious reusable site flows as `/skills/*.md` files with structured frontmatter (name/hosts/description); skills are priors and live page state always wins.
- Skill freshness loop: after two consecutive tool failures in a task that read skills, the error hints at revising the stale skill file (once per task).
- Builtin seed skills (versioned, idempotent): Hacker News, Reddit, GitHub, Wikipedia, Stack Exchange, npm registry, PyPI, and arXiv fetch-first API endpoints with data shapes, quota pitfalls, and fallbacks.
- Skills management UI in the side panel: list, enable/disable, and delete stored skills.
- `getDocument source:"url"`: direct fetch of http/https pages and PDFs (content-type routed) reusing the Readability/Markdown/table pipeline; failures explicitly point back to `navigate` + `currentPage`.
- `browser` coordinate targets `{ x, y }` (viewport CSS px): visual fallback for canvas/visual-only UIs, resolving through open shadow roots and failing clearly on iframes; viewport screenshots now include `width`/`height` in CSS px as the coordinate reference.
- Context spill: `getDocument` content over 12k chars and `browserRepl` JSON values over the same threshold are written to `/workspace/saved-<hash>.md|json` with a 4k preview, `savedTo`, and a read-back hint; identical content maps to the same file.
- Local database: `skills` table (v2), per-session `files` table pruned with sessions (v3), and a v4 repair migration that renames legacy skills whose names collide on the `/skills/<slug>.md` path (newest keeps its name, nothing deleted).
- ADR 0015 (agent-authored site skills), ADR 0016 (fs tool and file workspace), ADR 0017 (fetch-first URL reading).

#### Changed

- Fixed top-level tool set is now 6: `getDocument`, `extractImage`, `navigate`, `browser`, `browserRepl`, `fs` (debug builds still add `debugger`).
- Agent instructions v5: goal-anchored efficient loop (define done → smallest evidence → shortest path → act once → verify), fetch-first URL policy, and file/skill strategy.
- `getDocument source:"pdf"` merged into `source:"url"` (auto-detected); `source:"file"` now reads workspace files by name instead of accepting inline `fileText`.
- Product narrative updated to a powerful, all-capable side panel agent across CONTEXT/PRODUCT/plan; stop/resume and tool-trail mechanics unchanged.
- Store compliance disclosure now covers locally stored session files and site skills.
- New dependencies: `docx` and `mammoth`, both pure JS and dynamically imported so they load only when converting documents.

#### Fixed

- Builtin skill seeding no longer overwrites user- or agent-authored skills with the same name, and individual seed failures no longer abort the rest.
- Skill names that collide on the `/skills/<slug>.md` path are rejected at save time, and renaming a skill file is atomic (save first, then delete the old entry).
- Runtime smoke script asserted a hardcoded, outdated `instructionsVersion`; it now references the shared constant.

### 中文

#### 重点

- 新增 `fs` 工具：虚拟文件系统，用一套 `ls`/`read`/`write` 同时暴露每会话的 `/workspace` 文件区和 `/skills` 站点技能库。
- 新增站点技能系统：Agent 自行沉淀的可复用站点知识，支持懒加载披露、跨站提示、8 个大站内置种子和时效闭环。
- 新增 fetch-first URL 阅读：`getDocument source:"url"` 不开标签页直接拓取公开网页和 PDF，跨页收集可并行。
- 新增文档工作流：上传 PDF/Word/文本，任务产出 Markdown/HTML/CSV/Word，侧边栏下载，Markdown/HTML 可通过浏览器打印导出 PDF。
- 新增上下文经济：超大的文档和 REPL 输出自动落盘到 `/workspace`，模型上下文和事件日志只保留预览和稳定文件路径。

#### 新增

- `fs` 工具（`ls`/`read`/`write`）：`/workspace/<name>` 存会话上传与产出；`/skills/<slug>.md` 以 frontmatter Markdown 文件形态暴露站点技能，利用模型对文件系统操作的预训练先验。
- 文件工作区：写 `.md`/`.txt`/`.html`/`.csv`/`.json` 存文本；写 `.docx` 自动把 Markdown 转 Word（`docx` 库，按需加载）；上传的 `.docx`/`.pdf`/文本通过 `getDocument source:"file"` 解析为文本（mammoth/pdfjs）。
- 侧边栏文件 UI：输入框回形针上传（附件 chip + 提示词自动标注）；文件条支持下载、删除、导出 PDF；新增打印页（`print.html`，marked + DOMPurify）走浏览器原生排版导出高质量 PDF。
- 站点技能：任务指令附当前站点匹配技能摘要；`navigate`（全部动作）、`browser`、`browserRepl` 落到新 host 时统一附 `availableSkills` 提示，同 host 不重复。
- 技能沉淀闭环：Agent 把非显而易见、可复用的站点流程写成 `/skills/*.md`（结构化 frontmatter：name/hosts/description）；技能是先验，与页面实时状态冲突时以页面为准。
- 技能时效闭环：任务内读过技能后若工具连续失败两次，错误信息提示修订可能过时的技能文件（每任务只提示一次）。
- 内置种子技能（按版本幂等写入）：Hacker News、Reddit、GitHub、Wikipedia、Stack Exchange、npm、PyPI、arXiv 的 fetch-first API 端点，含数据结构、配额陷阱和回退方案。
- 侧边栏技能管理 UI：列表、启用/停用、删除。
- `getDocument source:"url"`：直接 fetch http/https 网页与 PDF（按 content-type 自动分流），复用 Readability/Markdown/表格解析管线；失败时明确引导回退 `navigate` + `currentPage`。
- `browser` 坐标 target `{ x, y }`（viewport CSS px）：canvas/纯视觉 UI 的视觉兜底，递归穿透 open shadow root，命中 iframe 时明确失败；视口截图结果附 CSS px 的 `width`/`height` 作为坐标基准。
- 上下文落盘：`getDocument` 内容超 12k 字符、`browserRepl` JSON 结果超同阈值时，全文写入 `/workspace/saved-<hash>.md|json`，结果携带 4k 预览、`savedTo` 路径和回读提示；相同内容幂等落到同一文件。
- 本地数据库：`skills` 表（v2）、随会话清理的 `files` 表（v3）、v4 修复迁移（对历史上 slug 碰撞的技能自动加后缀重命名，最新者保留原名，零数据丢失）。
- 新增 ADR 0015（Agent 沉淀的站点技能）、ADR 0016（fs 工具与文件工作区）、ADR 0017（fetch-first URL 阅读）。

#### 变更

- 固定顶层工具变为 6 个：`getDocument`、`extractImage`、`navigate`、`browser`、`browserRepl`、`fs`（debug 构建仍额外提供 `debugger`）。
- Agent 指令 v5：目标锚点高效循环（先明确完成标准 → 读最小证据 → 选最短路径 → 一次动作 → 验证），fetch-first URL 策略，文件与技能策略。
- `getDocument source:"pdf"` 并入 `source:"url"`（自动识别）；`source:"file"` 改为按名读取工作区文件，不再接受内联 `fileText`。
- 产品叙事更新为强大全能的浏览器侧边栏 Agent（CONTEXT/PRODUCT/plan）；停止/恢复与工具轨迹机制不变。
- 商店合规披露补充本地存储的会话文件与站点技能。
- 新增依赖 `docx` 与 `mammoth`：纯 JS，动态 import，仅在文档转换时加载。

#### 修复

- 内置种子不再覆盖用户/Agent 沉淀的同名技能；单个种子写入失败不再中断其余种子。
- 技能名 slug 碰撞导致 `/skills` 路径重复：保存时拒绝冲突，技能文件重命名改为原子操作（先保存后删旧），失败不丢数据。
- 运行时冒烟脚本硬编码的 `instructionsVersion` 已过时，改为引用共享常量。

## 0.2.1 - 2026-07-09

### English

#### Changed

- Improved the browser Agent efficiency loop: read minimal evidence, take one action, then verify fresh state.
- Clarified tool guidance so page changes use auto-wait or `waitFor`, not sleep/setTimeout polling.
- Made `browser.snapshot` ignore accidental target/action fields instead of failing.

#### Fixed

- Avoided an extra full snapshot after successful main-document browser actions when no iframes are present.
- Preserved frame-aware routing for iframe pages and ambiguity checks.

#### Added

- Tool run events and stored tool records now include `durationMs` for slow-tool inspection in side panel details.
- Added ADR 0014 documenting the browser Agent efficiency loop.

### 中文

#### 变更

- 优化浏览器 Agent 执行循环：先读最小证据，一次动作，再验证新状态。
- 明确工具指引：页面变化等待用自动等待或 `waitFor`，不用 sleep/setTimeout 轮询。
- `browser.snapshot` 忽略模型误带的 target/action 字段，不再因此失败。

#### 修复

- 无 iframe 页面里，主文档浏览器动作成功后不再额外做一次完整 snapshot。
- iframe 页面继续保留 frame-aware 路由和歧义检查。

#### 新增

- 工具运行事件和本地记录新增 `durationMs`，侧边栏技术详情可查看慢工具。
- 新增 ADR 0014，记录浏览器 Agent 高效执行循环。

## 0.2.0 - 2026-07-09

### English

#### Highlights

- Added first public Chrome MV3 release packaging: `taber-v0.2.0-chrome-mv3.zip`.
- Added subscription login for ChatGPT/Codex and xAI/Grok.
- Reworked the side panel into a product UI with settings, sessions, sources, image previews, toasts, and a compact tool trail.
- Added stronger browser-task flow: target-tab locking, Browser Access setup, streaming AgentHost, and persistent task events.

#### Added

- ChatGPT/Codex subscription login with PKCE, local token storage, model refresh, and sign out.
- xAI/Grok subscription login with browser OAuth, manual finish-code fallback, token refresh, and sign out.
- OpenAI API key accounts through the Responses API.
- OpenAI-compatible custom providers with presets, model metadata, context windows, and reasoning effort choices.
- Document and visual extraction for pages, selections, PDFs, text files, viewport screenshots, page images, canvas, and background images.

#### Changed

- Release builds keep `debugger` out of the extension manifest. The debugger tool is only available in `TABER_ENABLE_DEBUGGER=1` local builds.
- Browser tasks require Browser Access setup for website access and User Scripts before page work starts.
- Release install docs now point to the Chrome MV3 zip and unpacked extension flow.

#### Security

- Provider credentials stay in IndexedDB and are used only for the selected provider.
- Release build verification checks the permission set and provider auth hosts used by ChatGPT/Codex and xAI/Grok login.

### 中文

#### 重点

- 新增首个公开 Chrome MV3 Release 包：`taber-v0.2.0-chrome-mv3.zip`。
- 新增 ChatGPT/Codex 与 xAI/Grok 订阅登录。
- 侧边栏重做为产品界面：设置、会话、来源、图片预览、toast 和紧凑工具轨迹。
- 浏览器任务流程增强：target tab 锁定、Browser Access 引导、流式 AgentHost 和持久任务事件。

#### 新增

- ChatGPT/Codex 订阅登录：PKCE、本地 token 存储、模型刷新和退出登录。
- xAI/Grok 订阅登录：浏览器 OAuth、手动 finish code 兜底、token 刷新和退出登录。
- OpenAI API key 账号，走 Responses API。
- OpenAI-compatible 自定义供应商，支持预设、模型元数据、context window 和 reasoning effort。
- 文档与视觉提取：页面、选区、PDF、文本文件、当前视口截图、页面图片、canvas 和 background image。

#### 变更

- Release 构建不在 manifest 中包含 `debugger`。debugger 工具只在 `TABER_ENABLE_DEBUGGER=1` 的本地构建里可用。
- 浏览器任务开始前需要完成 Browser Access 的站点访问和 User Scripts 设置。
- Release 安装说明改为指向 Chrome MV3 zip 和加载已解压扩展流程。

#### 安全

- 供应商凭证保存在 IndexedDB，只用于你选择的供应商。
- Release 构建校验会检查权限集合，以及 ChatGPT/Codex 和 xAI/Grok 登录所需 auth host。
