# Taber Agent 索引

## 产品背景

- 产品用语：`CONTEXT.md`
- 架构决策：`docs/adr/`
- 产品/设计背景：`PRODUCT.md`、`DESIGN.md`

## 架构与关键约束

技术栈：WXT + Svelte 5 + AI SDK v6 `ToolLoopAgent` + Dexie；供应商统一配置 `name / baseURL / apiKey / model / contextWindowTokens`。

```txt
sidepanel           用户监督 UI，展示对话、工具时间线、任务状态
AgentHost           offscreen document，运行 ToolLoopAgent，任务期间懒创建
ChromeApiBroker     background service worker，代理 tabs/scripting/userScripts；debug 构建才代理 debugger
content/userScripts 页面观察、交互和用户同意后的 browserjs 执行
Dexie               单一本地数据源，保存配置、会话、事件日志
```

顶层工具固定 6 个：`getDocument` / `extractImage` / `navigate` / `browser`（页面操作主路径）/ `browserRepl`（高级 fallback）/ `fs`（文件工作区 + 站点技能，ADR 0015/0016）；debug 构建（`TABER_ENABLE_DEBUGGER=1`）额外暴露 `debugger`。

- 同一时间只运行一个全局 Agent 任务；AgentHost 有任务才创建，完成后保留 2 分钟空闲关闭
- Chrome offscreen 的 `runtime` 是受限子集，实测无 `getManifest`；需要扩展版本时使用编译期常量，不在 AgentHost 运行时读取 manifest
- 侧边栏不是状态源；打开时从 Dexie 事件日志重建 UI
- 任务启动时锁定侧边栏所属窗口的 active tab 为 target；非 http/https 也可启动，用户手动切 tab 不改 target，只有 `navigate.switchTab`、`navigate.open target:"new"` 或侧边栏确认才切换（ADR 0018）
- 前台模式偏好保存在 Dexie，默认关闭并在任务启动时固定；开启只激活 Chrome 内的 target tab，关闭除 viewport 截图外后台执行，两种模式都不聚焦 Chrome 窗口（ADR 0019）
- target tab 关闭或不存在时任务明确失败，不回退到其他 tab；target 暂时不可操作时仅页面工具失败，任务仍可导航恢复；除 `navigate.switchTab` 外，工具显式传入其他 `tabId` 必须失败
- 上架版只申请必要权限，站点访问走 `optional_host_permissions`；`browserRepl` 不暴露裸 `chrome.*`

## 主要模块

- 后台 broker、前台模式与扩展生命周期：`entrypoints/background.ts`、`lib/foreground-mode.ts`、`lib/chrome-api-broker.ts`、`lib/offscreen-lifecycle.ts`、`lib/agent-host-controller.ts`
- Offscreen AgentHost：`entrypoints/offscreen/main.ts`、`lib/agent-instructions.ts`、`lib/agent-tools.ts`
- Agent 事件投影：`lib/agent-event-projection.ts`、`lib/agent-event-text.ts`、`lib/sidepanel-view.ts`、`lib/model-context.ts`
- 站点技能与文件工作区：`lib/skills.ts`、`lib/skills-seeds.ts`、`lib/workspace-files.ts`、`lib/fs-tool.ts`、`lib/document-export.ts`、`docs/adr/0015`、0016、0017；target 与激活规则见 ADR 0011、0018、0019
- 固定工具：`lib/get-document.ts`、`lib/get-document-page.ts`、`lib/document-markdown.ts`、`lib/extract-image.ts`、`lib/navigate.ts`、`lib/browser-tool.ts`、`lib/browser-repl.ts`、`lib/browser-repl-command.ts`、`lib/browser-repl-evaluation.ts`、`lib/browser-repl-executor.ts`、`lib/browser-repl-page.ts`、`lib/browser-repl-page-runtime.ts`、`lib/browser-repl-page-locator.ts`、`lib/browser-repl-page-introspection.ts`、`lib/browser-repl-code.ts`、`lib/browser-js-page-script.ts`、`lib/browser-repl-visual-page.ts`、`lib/debugger-tool.ts`；模型输入规范化见 ADR 0020
- 侧边栏 UI：`entrypoints/sidepanel/App.svelte`、`entrypoints/sidepanel/SourcesBar.svelte`、`entrypoints/sidepanel/Timeline.svelte`、`entrypoints/sidepanel/ActivityGroup.svelte`、`lib/sidepanel-i18n.ts`、`lib/components/ai-elements/tool/tool-header.svelte`
- 官方订阅 UI：`SubscriptionHub.svelte`、`SubscriptionLoginCard.svelte`、`OpenAILogo.svelte`、`GrokLogo.svelte`、`lib/subscription-login.ts`
- 供应商设置 UI：`ProviderSettings.svelte`、`SettingsBackButton.svelte`、`SettingsActionBar.svelte`、`ProviderSecretInput.svelte`
- 本地数据库与 supplier 配置流程：`lib/db.ts`、`lib/provider-config-flow.ts`
- 浏览器 OAuth 公共件：`lib/oauth-browser.ts`（PKCE / tab 截获 / token 交换）
- ChatGPT 订阅：`lib/codex-oauth.ts`、`lib/codex-auth.ts`、`lib/codex-provider.ts`、`lib/codex-runtime.ts`
- xAI 订阅：`lib/xai-oauth.ts`、`lib/xai-auth.ts`、`lib/xai-provider.ts`、`lib/xai-runtime.ts`

## 验证

- 单元测试：`pnpm run test:unit`
- 会话日志诊断（导出 / CDP dump）：`docs/debugging.md`、`lib/session-export.ts`、`scripts/dump-session-events.ts`
- 确定性 E2E 场景（含 5 条 MVP 任务事实源）：`pnpm run test:e2e`（`scripts/test-e2e-scenarios.ts`）
- 完整 CI：`pnpm run test:ci`
- 可选运行时浏览器冒烟测试：`pnpm run test:ci:runtime`
