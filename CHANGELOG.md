# Changelog

<p align="center">
  <a href="#english">🇺🇸 English</a> · <a href="#中文">🇨🇳 中文</a>
</p>

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
