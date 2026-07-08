# Taber Documentation Index

> **Languages**: [English](#english) · [中文](#中文)

---

## English

Project documents are split by purpose.

### Project context

- [`CONTEXT.md`](../CONTEXT.md) — product vocabulary and Avoid-list (Chinese)
- [`PRODUCT.md`](../PRODUCT.md) — users, purpose, brand personality, design principles (Chinese)
- [`DESIGN.md`](../DESIGN.md) — side panel visual design intent; token values live in `entrypoints/sidepanel/app.css`
- [`AGENTS.md`](../AGENTS.md) — module map for agents and contributors (Chinese)

### Architecture (ADRs)

- [`docs/adr/0001-split-browser-tool-boundary.md`](adr/0001-split-browser-tool-boundary.md)
- [`docs/adr/0002-use-userscripts-for-browser-repl-page-execution.md`](adr/0002-use-userscripts-for-browser-repl-page-execution.md)
- [`docs/adr/0003-request-full-browser-agent-permissions-up-front.md`](adr/0003-request-full-browser-agent-permissions-up-front.md)
- [`docs/adr/0004-use-openai-compatible-provider-shape.md`](adr/0004-use-openai-compatible-provider-shape.md)
- [`docs/adr/0005-use-dexie-as-local-agent-database.md`](adr/0005-use-dexie-as-local-agent-database.md)
- [`docs/adr/0006-run-agent-in-offscreen-document.md`](adr/0006-run-agent-in-offscreen-document.md)
- [`docs/adr/0007-rebuild-sidebar-from-agent-event-log.md`](adr/0007-rebuild-sidebar-from-agent-event-log.md)
- [`docs/adr/0008-run-one-global-agent-task.md`](adr/0008-run-one-global-agent-task.md)
- [`docs/adr/0009-keep-debugger-tool-always-available.md`](adr/0009-keep-debugger-tool-always-available.md)
- [`docs/adr/0010-build-document-extraction-with-lightweight-parsers.md`](adr/0010-build-document-extraction-with-lightweight-parsers.md)
- [`docs/adr/0011-use-task-target-tab-as-browser-agent-workspace.md`](adr/0011-use-task-target-tab-as-browser-agent-workspace.md)
- [`docs/adr/0012-use-openai-responses-provider-for-chatgpt-codex.md`](adr/0012-use-openai-responses-provider-for-chatgpt-codex.md)
- [`docs/adr/0013-agent-instructions-v2.md`](adr/0013-agent-instructions-v2.md)

### Planning and UX

- [`docs/plan.md`](plan.md) — build plan and E2E success criteria (Chinese)
- [`docs/development.md`](development.md)
- [`docs/local-database.md`](local-database.md)
- [`docs/model-context-plan.md`](model-context-plan.md)
- [`docs/plan-sidebar-ui-rebuild.md`](plan-sidebar-ui-rebuild.md) (Chinese)
- [`docs/sidepanel-next-ux-plan.md`](sidepanel-next-ux-plan.md)
- [`docs/sidepanel-ux-polish.md`](sidepanel-ux-polish.md)

### Publishing

- [`../CHANGELOG.md`](../CHANGELOG.md)
- [`docs/store-compliance.md`](store-compliance.md) — Chrome Web Store disclosure facts (least-privilege policy)

### Governance

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) · [`../SECURITY.md`](../SECURITY.md)

---

## 中文

项目文档按用途分。

### 项目背景

- [`CONTEXT.md`](../CONTEXT.md) — 产品用语与 Avoid 列表
- [`PRODUCT.md`](../PRODUCT.md) — 用户、目的、品牌人格、设计原则
- [`DESIGN.md`](../DESIGN.md) — 侧边栏视觉设计意图；token 具体值在 `entrypoints/sidepanel/app.css`
- [`AGENTS.md`](../AGENTS.md) — 给 Agent 和贡献者的模块地图

### 架构决策（ADR）

- [`docs/adr/0001-split-browser-tool-boundary.md`](adr/0001-split-browser-tool-boundary.md) — 拆分浏览器工具边界
- [`docs/adr/0002-use-userscripts-for-browser-repl-page-execution.md`](adr/0002-use-userscripts-for-browser-repl-page-execution.md) — 用 userScripts 执行 REPL 页面脚本
- [`docs/adr/0003-request-full-browser-agent-permissions-up-front.md`](adr/0003-request-full-browser-agent-permissions-up-front.md) — 上架版使用最小浏览器权限
- [`docs/adr/0004-use-openai-compatible-provider-shape.md`](adr/0004-use-openai-compatible-provider-shape.md) — 用 OpenAI-compatible 供应商形态
- [`docs/adr/0005-use-dexie-as-local-agent-database.md`](adr/0005-use-dexie-as-local-agent-database.md) — 用 Dexie 做本地 Agent 数据库
- [`docs/adr/0006-run-agent-in-offscreen-document.md`](adr/0006-run-agent-in-offscreen-document.md) — 在 offscreen document 运行 Agent
- [`docs/adr/0007-rebuild-sidebar-from-agent-event-log.md`](adr/0007-rebuild-sidebar-from-agent-event-log.md) — 用事件日志恢复侧边栏
- [`docs/adr/0008-run-one-global-agent-task.md`](adr/0008-run-one-global-agent-task.md) — 全局只跑一个 Agent 任务
- [`docs/adr/0009-keep-debugger-tool-always-available.md`](adr/0009-keep-debugger-tool-always-available.md) — debugger 只在 debug 构建可用
- [`docs/adr/0010-build-document-extraction-with-lightweight-parsers.md`](adr/0010-build-document-extraction-with-lightweight-parsers.md) — 用轻量解析器实现文档提取
- [`docs/adr/0011-use-task-target-tab-as-browser-agent-workspace.md`](adr/0011-use-task-target-tab-as-browser-agent-workspace.md) — 任务级 target tab 是浏览器 Agent 工作区事实源
- [`docs/adr/0012-use-openai-responses-provider-for-chatgpt-codex.md`](adr/0012-use-openai-responses-provider-for-chatgpt-codex.md) — 用 OpenAI Responses provider 驱动 ChatGPT Codex
- [`docs/adr/0013-agent-instructions-v2.md`](adr/0013-agent-instructions-v2.md) — Agent 指令 v2

### 计划与 UX

- [`docs/plan.md`](plan.md) — 构建计划与 E2E 成功标准
- [`docs/development.md`](development.md)
- [`docs/local-database.md`](local-database.md)
- [`docs/model-context-plan.md`](model-context-plan.md)
- [`docs/plan-sidebar-ui-rebuild.md`](plan-sidebar-ui-rebuild.md) — 侧边栏 UI 重构
- [`docs/sidepanel-next-ux-plan.md`](sidepanel-next-ux-plan.md)
- [`docs/sidepanel-ux-polish.md`](sidepanel-ux-polish.md)

### 发布

- [`../CHANGELOG.md`](../CHANGELOG.md)
- [`docs/store-compliance.md`](store-compliance.md) — Chrome Web Store 披露事实（最小权限策略）

### 治理

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) · [`../SECURITY.md`](../SECURITY.md)
