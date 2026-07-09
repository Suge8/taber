# Changelog

<p align="center">
  <a href="#english">🇺🇸 English</a> · <a href="#中文">🇨🇳 中文</a>
</p>

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
