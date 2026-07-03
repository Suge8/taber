# 侧边栏 UI 重构计划（Svelte AI Elements）

> Historical implementation plan. Current architecture facts are in `docs/plan.md`, `CONTEXT.md`, `docs/adr/`, and `docs/local-database.md`; do not treat the old permission/offscreen/provider-store notes below as current invariants.

## 目标

把 Taber 侧边栏从粗糙的 demo 界面重构成极简、现代、动效丝滑的产品界面，并补齐首次可用所必需的 Provider/API Key/Model 配置 UI。用户加载扩展后无需打开控制台写 IndexedDB，直接在 UI 内配置 provider 并启动任务。

体验是第一目标：美观、舒服、丝滑。技术决策为体验服务。

## 关键事实（已核实）

- **Svelte AI Elements 不是 npm 包**，是 shadcn-svelte registry（`https://svelte-ai-elements.vercel.app/r/*.json`），通过 `npx shadcn-svelte@latest add <url>` 把组件源码拷进本地 `src/lib/components/ai-elements/*`。
- 前置依赖：Tailwind CSS v4、shadcn-svelte、bits-ui、`tailwind-merge`/`clsx`/`tailwind-variants`、`lucide-svelte`、`mode-watcher`。
- 当前项目零 Tailwind、零 shadcn、无 `components.json`、无 `svelte.config`。WXT + `@wxt-dev/module-svelte`，Svelte 5。
- `entrypoints/offscreen/main.ts` 按 `settings.selectedModelId → models.get(id) → providers.get(providerId)` 读取，缺失时回退到第一个 provider/model。**这个 schema 读取契约不能破坏。**
- Dexie schema 已支持 N provider × N model（`providers{id,name,baseURL,apiKey}`、`models{id,providerId,name}`、`settings.selectedModelId`）。多 provider/model CRUD 不需要改 schema。
- manifest 有 `<all_urls>` host 权限，sidepanel 内 `fetch` 任意 baseURL 做连通性校验没问题。

## 已对齐决策

| # | 决策 | 说明 |
|---|------|------|
| Q1 | 接受 Tailwind v4 + shadcn-svelte 基础设施 | 仅 sidepanel entry 加载；background/offscreen/content/sandbox 一行不动 |
| Q2 | 首屏 Onboarding + Sheet 抽屉 | 无 model 时主区直接是配置表单；已配置后入口收进顶部齿轮 → 右滑 Sheet |
| Q3 | 多 provider × 多 model CRUD | 完整增删改；schema 不动 |
| Q4 | apiKey 可选「Test connection」+ 掩码显示 | 不阻塞保存；password input 可切换显隐；列表显示 `sk-…last4`；Dexie 明文存（沿用 ADR 0005，本次不加密） |
| Q5 | 单栏时间流（D） | messages + tool 调用按 `createdAt` 归并成一条流，用 AI Elements `Conversation`/`Message`/`Tool` 渲染；Sources/Image/Context/Model 收进顶部状态条或可折叠区 |
| Q6 | 按职责拆 Svelte 组件 | `App.svelte` 只做编排；状态用 `$state`+props+async 函数，不引状态库 |
| Q7 | 不动 schema | 删 provider 级联删其 models；若删掉的 model 是 selectedModelId 则清空/回退；逻辑放 store 层 |

## 硬约束

- 侧边栏只能从 Dexie `agentEvents` 恢复 conversation / task / timeline / sources / image。
- 不展示 raw chain-of-thought / raw reasoning / `<think>`（沿用 `sidepanel-view.ts` 已有的 `hideReasoningText` / `hiddenKeyPattern`）。
- 不改 browserRepl 安全边界。
- 不改 debugger cookie 禁止规则。
- 不改 AgentHost / ChromeApiBroker / offscreen 架构。
- 不新增大型状态管理库。
- `App.svelte` ≤300 行；样式走 Tailwind v4 `@theme` + `app.css`。
- 最小改动，不重写无关模块。安全边界相关文件零改动。

## 视觉与动效目标

风格基准：Linear / Notion / Arc。延续 DESIGN.md 的「克制的产品 UI」并升级。

- **配色**：沿用 DESIGN.md 调色板搬进 Tailwind v4 `@theme` token（OKLCH 优先）。bg `#f7f8fb` / dark `#0f141d`，accent `#1d4ed8` / dark `#8ab4ff`，1px 边框，无装饰性阴影。
- **排版**：Inter 优先，回退 system UI。12px label / 13px body / 18px title，counter 与 status 用 tabular numbers。
- **布局**：单栏侧边栏，窄宽度不溢出，所有文本/代码区 overflow wrapping。
- **动效（丝滑是重点）**：
  - 默认遵守 `prefers-reduced-motion`，reduced 时全部降级为即时。
  - 消息/工具块入场：opacity + 4px translateY，~180ms ease-out，逐条轻微 stagger。
  - Tool 折叠展开：height/opacity transition ~160ms。
  - Sheet 抽屉：右滑入 ~220ms cubic-bezier，带 backdrop fade。
  - 状态 pill（idle/running/failed/cancelled）：颜色与 running 呼吸态平滑过渡。
  - 控件 hover/focus：border + opacity 160ms（沿用 DESIGN.md Motion 规则）。
  - Conversation 自动贴底滚动用 AI Elements `Conversation` 内建行为，不用轮询。
- **空状态**：onboarding 和空对话给清晰、友好的引导文案，不像 demo 占位符。

## 任务分片与验证点

### 0. 基础设施
- 装 Tailwind v4（`tailwindcss`、`@tailwindcss/vite`）并在 `wxt.config.ts` 接入 vite 插件。
- 初始化 shadcn-svelte（`components.json`、`svelte.config.js`、path alias），确认组件落地目录（`lib/components/ui/*`、`lib/components/ai-elements/*`，与项目 `lib/` 约定一致）。
- `app.css` 改为 Tailwind v4 `@theme` token；旧 240 行手写 CSS 中仍需要的部分迁移，其余作废。
- 依赖版本 pin，确认 shadcn-svelte 组件兼容 Svelte 5。
- **验证**：`pnpm build:chrome` 通过；sidepanel 能加载并渲染 Tailwind 样式。

### 1. Provider/Model store（`lib/provider-store.ts`）
- 纯 async 函数集合，不引状态库：`listProviders`、`listModels`、`saveProvider`、`updateProvider`、`deleteProvider`（级联删 models + selected 回退）、`saveModel`、`deleteModel`、`getSelectedModelId`、`setSelectedModelId`、`testConnection(baseURL, apiKey)`。
- `testConnection`：sidepanel 内 `fetch(baseURL + /models)`（或最小请求），返回 ok/错误，不碰 AgentHost。
- 严格保持 offscreen 读取契约：写入的 provider/model/settings 形状不变。
- **验证**：单测覆盖级联删除、selected 回退、保存后 `selectedModelId` 可被 offscreen 读取路径解析。复用现有 `test:unit` 风格脚本。

### 2. Provider Settings UI（`ProviderSettings.svelte`）
- 多 provider 列表 + 每 provider 下多 model；增/删/改。
- 字段：provider name、baseURL、apiKey（password + 显隐切换）、model name。
- Save / Update / Delete；apiKey 列表掩码；可选 Test connection 按钮显示结果。
- 用 shadcn-svelte `Sheet`（已配置后入口）+ 表单组件（input/button/card）。
- **验证**：保存后 model selector 立即可选；删 provider 级联生效；UI 不再需要控制台。

### 3. 首屏 Onboarding 路由
- `App.svelte` 编排：db ready 且无任何可用 model → 渲染 onboarding（复用 `ProviderSettings` 的表单形态）；有 model → 渲染主界面，配置入口收进顶部齿轮。
- **验证**：全新安装（空 Dexie）打开 sidepanel 直接看到配置表单；配置完成后切到主界面。

### 4. 时间流归并（`lib/sidepanel-view.ts` 加 `deriveTimeline`）
- 新增 `deriveTimeline(events)`：把 `deriveConversation` 与 `deriveToolTimeline` 结果按 `createdAt` 归并成 `{kind:'message'|'tool', ...}[]`。
- 纯函数，保留现有 reasoning 隐藏逻辑，不改既有导出。
- **验证**：单测覆盖归并顺序（tool 出现在触发它的 assistant 消息之后）；扩展现有 `test-sidepanel-view.ts`。

### 5. Timeline + Composer 组件
- `Timeline.svelte`：`Conversation` 包裹归并流，`Message` 渲染消息，AI Elements `Tool` 渲染工具块（header=toolName+status，展开看 input/output/error）。入场动画 + stagger + reduced-motion 降级。
- `Composer.svelte`：AI Elements PromptInput（或其推荐组合）+ Start/Stop，沿用现有 `startTask`/`stopTask` 消息协议。
- Sources / Image / Context / Model selector 收进顶部状态条或可折叠区。
- **验证**：消息与工具按时间正确穿插；Stop 在 running 时可用；窄宽度不溢出。

### 6. App.svelte 收口
- 只保留：db 加载、事件订阅、onboarding/主界面路由、theme、错误展示。拆出的逻辑进各子组件与 store。
- 保证 ≤300 行。
- **验证**：行数达标；`prefers-reduced-motion` 生效；刷新后从 `agentEvents` 恢复对话/任务/时间线/sources/image。

### 7. 全量验证
- `pnpm run test:unit` / `pnpm run test:e2e` / `pnpm build:chrome` / `pnpm build:edge`。
- 安全边界相关单测（chrome-api-broker、browser-repl、navigate、document-image-debugger）零回退。
- 浏览器内手测：全新安装 → 配置 provider → 启动任务 → 关闭重开侧边栏恢复。

## 成功标准

- 用户加载扩展后能在 UI 内配置 provider/baseURL/apiKey/model，保存后可直接启动任务，无需控制台。
- UI 使用 Svelte AI Elements（Conversation/Message/Tool + PromptInput）。
- UI 看起来像现代产品（Linear/Notion/Arc），动效丝滑、遵守 reduced-motion，不像默认 demo。
- 侧边栏刷新/重开后仍从 `agentEvents` 恢复 conversation/task/timeline/sources/image。
- 安全边界测试全绿，无回退。
- AgentHost / ChromeApiBroker / offscreen / browserRepl / debugger 架构与文件零改动。

## 任务启动提示词

> 按 `docs/plan-sidebar-ui-rebuild.md` 重构 Taber 侧边栏 UI。
>
> 先做分片 0（基础设施）：装 Tailwind v4 + shadcn-svelte，接入 WXT vite 插件，初始化 components.json/svelte.config，用 shadcn-svelte CLI 添加 AI Elements 的 conversation/message/tool/prompt-input 及依赖的 ui 组件。确认组件兼容 Svelte 5，依赖版本 pin。`pnpm build:chrome` 通过后再继续。
>
> 然后按分片 1→6 顺序实现：provider-store（含级联删除与 selected 回退、testConnection）、ProviderSettings.svelte、onboarding 路由、deriveTimeline 归并、Timeline/Composer 组件、App.svelte 收口到 ≤300 行。
>
> 硬约束：只动 sidepanel entry + 新增组件 + Tailwind/shadcn 配置 + provider-store + sidepanel-view 的新增函数。AgentHost/ChromeApiBroker/offscreen/browserRepl/debugger 一行不改。保持 offscreen 的 selectedModelId→model→provider 读取契约。不展示 raw reasoning。不引状态管理库。
>
> 视觉：Linear/Notion/Arc 风，极简舒服，动效丝滑（入场 stagger、Tool 折叠、Sheet 右滑、status pill 过渡），遵守 prefers-reduced-motion。配色沿用 DESIGN.md 搬进 Tailwind @theme。
>
> 每个分片后跑受影响测试。最后跑 `pnpm run test:unit && pnpm run test:e2e && pnpm build:chrome && pnpm build:edge`，安全边界测试不许回退。
