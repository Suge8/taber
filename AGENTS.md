# Taber Agent 索引

## 产品背景

- 产品用语：`CONTEXT.md`
- 构建计划与 E2E 目标：`docs/plan.md`
- 架构决策：`docs/adr/`
- 产品/设计背景：`PRODUCT.md`、`DESIGN.md`

## 主要模块

- 后台 broker 与扩展生命周期：`entrypoints/background.ts`、`lib/chrome-api-broker.ts`、`lib/offscreen-lifecycle.ts`、`lib/agent-host-controller.ts`
- Offscreen AgentHost：`entrypoints/offscreen/main.ts`、`lib/agent-instructions.ts`、`lib/agent-tools.ts`
- Agent 事件投影：`lib/agent-event-projection.ts`、`lib/agent-event-text.ts`、`lib/sidepanel-view.ts`、`lib/model-context.ts`
- 固定工具：`lib/get-document.ts`、`lib/get-document-page.ts`、`lib/document-markdown.ts`、`lib/extract-image.ts`、`lib/navigate.ts`、`lib/browser-tool.ts`、`lib/browser-repl.ts`、`lib/browser-repl-command.ts`、`lib/browser-repl-executor.ts`、`lib/browser-repl-page.ts`、`lib/browser-repl-page-runtime.ts`、`lib/browser-repl-page-locator.ts`、`lib/browser-repl-page-introspection.ts`、`lib/browser-repl-code.ts`、`lib/browser-js-page-script.ts`、`lib/browser-repl-visual-page.ts`、`lib/debugger-tool.ts`
- 侧边栏 UI：`entrypoints/sidepanel/App.svelte`、`entrypoints/sidepanel/SourcesBar.svelte`、`entrypoints/sidepanel/Timeline.svelte`、`lib/sidepanel-i18n.ts`、`lib/components/ai-elements/tool/tool-header.svelte`
- 官方订阅 UI：`SubscriptionHub.svelte`、`SubscriptionLoginCard.svelte`、`OpenAILogo.svelte`、`GrokLogo.svelte`、`lib/subscription-login.ts`
- 供应商设置 UI：`ProviderSettings.svelte`、`SettingsBackButton.svelte`、`SettingsActionBar.svelte`、`ProviderSecretInput.svelte`
- 本地数据库与 supplier 配置流程：`lib/db.ts`、`lib/provider-config-flow.ts`
- 浏览器 OAuth 公共件：`lib/oauth-browser.ts`（PKCE / tab 截获 / token 交换）
- ChatGPT 订阅：`lib/codex-oauth.ts`、`lib/codex-auth.ts`、`lib/codex-provider.ts`、`lib/codex-runtime.ts`
- xAI 订阅：`lib/xai-oauth.ts`、`lib/xai-auth.ts`、`lib/xai-provider.ts`、`lib/xai-runtime.ts`

## 验证

- 单元测试：`pnpm run test:unit`
- 确定性 E2E 场景：`pnpm run test:e2e`
- 完整 CI：`pnpm run test:ci`
- 可选运行时浏览器冒烟测试：`pnpm run test:ci:runtime`
