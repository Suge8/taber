# Sidepanel next UX plan

## 目标

继续把 Taber 侧边栏做得更像产品，而不是工具日志：快捷操作更有仪式感，工具轨迹默认更轻，AI 回复真正流式，模型选择更短，模型设置页更清爽。

## 调研结论

### 1. AI 回复为什么现在不是流式

事实：AI SDK 支持流式，当前代码没用。

- 当前实现：`entrypoints/offscreen/main.ts` 用 `runtime.agent.generate({ messages, abortSignal })`。
- `generate()` 是阻塞式：等完整结果回来后才写 `task.completed`。
- AI SDK v6 的 `ToolLoopAgent` 有 `.stream()`，返回 `StreamTextResult`。
- `StreamTextResult` 有：
  - `textStream`：只拿文字 delta。
  - `fullStream`：文字、reasoning、tool-call、tool-result、error 等完整事件。
- 本地 `Response` 组件只是按 `content` 渲染 markdown；只要上游不断更新 message text，它可以跟着刷新。
- 当前 `deriveConversation()` 读 `message.created/message.appended`，但没有 producer 写这些事件，而且现在 append 还没按 `messageId` 聚合。

结论：不是 AI SDK 或 Svelte AI Elements 不支持，是我们 offscreen 仍在用 blocking `generate()`，事件协议还没接流式 delta。

推荐实现：单独做一个 streaming goal，中等复杂度。

最小事件协议：

```ts
message.created  { taskId, messageId, role: 'assistant', text: '' }
message.appended { taskId, messageId, delta: string }
task.completed   { taskId, text }
```

视图派生规则：

- `message.created + message.appended` 按 `messageId` 合并成一个 assistant message。
- 如果某个 task 已有 streaming assistant message，`task.completed.text` 只作为终态/恢复校验，不再重复显示一条 assistant。
- 刷新/重开从 `agentEvents` 恢复完整流式结果。
- `reasoning-delta` 不展示正文；如需保留，只能进低权重 debug evidence，且继续隐藏 chain-of-thought。

推荐 offscreen 流程：

```ts
const result = await runtime.agent.stream({ messages, abortSignal });
await emitAgentEvent(sessionId, 'message.created', { taskId, messageId, role: 'assistant', text: '' });

let text = '';
for await (const part of result.fullStream) {
  if (part.type === 'text-delta') {
    text += part.text;
    await emitAgentEvent(sessionId, 'message.appended', { taskId, messageId, delta: part.text });
  }
}

await emitAgentEvent(sessionId, 'task.completed', { taskId, text });
```

注意：`fullStream` 会包含 tool events，但我们已有 tool execute wrapper 写 `tool.started/tool.completed/tool.failed`，第一版不要重复写 tool-call 事件。

### 2. Quick actions 现在为什么变成四个都填输入框

事实：这是上轮 UX polish 按文档实现的，不是 bug。

- `docs/sidepanel-ux-polish.md` 写了：点击 quick action 填入输入框，不自动发送。
- 当前 `Composer.svelte` 的 `fillSuggestion(mode)` 只设置 `draft`。

但体验判断：四个按钮都只是填充，交互太平，产品感变弱。

推荐恢复成混合交互：

- `总结`：点击后直接发送，只作用于当前页。
- `翻译`：点击后直接发送，只作用于当前页。
- `调研`：展开轻量 `inline intent panel`，可输入主题，也可留空。
- `比价`：展开轻量 `inline intent panel`，可输入产品，也可留空。
- `调研/比价` 面板支持多选已打开标签页；当前页默认参与。
- 输入为空且没选额外标签页时，走当前页 prompt。
- 输入 + 标签页都存在时，走 `researchTabsTopic` / `compareTabsTopic`。

视觉设计（taste：Premium utilitarian minimalism）：

- 4 个入口默认单行紧凑排列；宽度不够时自然换成两行，不固定做 2×2 大卡片。
- 入口像 product shortcut / chip，不像普通表单按钮；文案短：`总结` / `调研` / `翻译` / `比价`。
- 点击 `调研/比价` 后，不弹 modal；在 quick action 区域原地展开一条 `inline intent panel`。
- 面板结构：动作图标 + 输入 + 标签页选择 + `发送` + `取消`。
- 标签页选择显示 favicon、标题、host；无 favicon 用 fallback icon。
- 标签页列表最多 4-5 行滚动，避免占满 composer 空间。
- 动效：只用 CSS/Svelte，`opacity + translateY(4px)`，150-220ms；遵守 reduced-motion。
- 不新增 Motion/GSAP。

建议文案：

- 总结
- 调研
- 翻译
- 比价
- 输入 placeholder：`主题，留空则调研当前页` / `产品，留空则比价当前页`

### 3. 工具组为什么默认展开

事实：当前逻辑故意让最新组和失败组展开。

- `Timeline.svelte`：`entry.id === latestToolGroupId || entry.group.status === 'failed'` 会自动打开。
- 这是上轮文档里的策略：latest group expanded，failed groups auto-expand。

但现在目标偏“更简洁、更美观”，默认全展开会重新变成日志感。

推荐新规则：

- completed：默认折叠，只显示胶囊堆叠。
- running：默认展开，显示正在做什么。
- failed：默认半展开，只显示人话错误摘要 + 胶囊；完整 tool 顺序仍需点开。
- 用户手动展开/折叠后，只在当前 sidepanel runtime 内保留 UI 状态。
- 不写 DB；刷新/重开后回到默认策略：completed 折叠、running 展开、failed 半展开。

视觉：失败态不要大红日志块，用轻红 accent + 一句错误摘要。

### 4. 模型选择器为什么太长

事实：当前 composer 底部显示 `Provider · model`。

- `App.svelte` 的 `selectedModelLabel = provider.name + ' · ' + model.name`。
- Composer 直接展示这个 label。

推荐：composer 只显示模型名，不显示 provider。

- 主显示：模型 icon + `gpt-5.5` / `claude-sonnet-4`。
- 二级信息放 dropdown 里：provider 名、base URL、context window。
- 若不同 provider 有同名模型，dropdown 中再显示 provider，composer 仍只显示模型名。
- 右侧增加 reasoning selector：思考 icon + `默认/低/中/高`。

这属于低风险 UI 调整。

### 5. 思考强度现在是不是硬编码

事实：现在没有配置 reasoning effort。不是硬编码成某个值，而是完全交给 provider/model 默认值。

- `createConfiguredRuntime()` 创建 `ToolLoopAgent({ model, instructions, tools })`。
- 没传 `providerOptions`。
- 项目使用 `@ai-sdk/openai-compatible`，不是官方 `@ai-sdk/openai` / `@ai-sdk/anthropic` provider。
- openai-compatible provider 支持：
  - `providerOptions.openaiCompatible.reasoningEffort`
  - `providerOptions.openaiCompatible.textVerbosity`
  - 也支持 provider name key / camelCase provider key。
- `reasoningEffort` 最终会变成 OpenAI-compatible request body 的 `reasoning_effort`。

推荐：做，但不要重做 provider 架构。

最小方案：全局 selected model 的“思考强度”设置，存在 `settings` 表，不改 DB schema。

```ts
settings: {
  key: 'reasoningEffort',
  value: 'default' | 'low' | 'medium' | 'high'
}
```

调用时：

```ts
providerOptions: reasoningEffort === 'default'
  ? undefined
  : { openaiCompatible: { reasoningEffort } }
```

UI：

- Composer 模型下拉旁边加一个小 `思考` selector。
- 展示：思考 icon + `默认/低/中/高`。
- 映射：
  - 默认 → 不传 `providerOptions`，使用 provider/model 默认行为。
  - 低 → `low`
  - 中 → `medium`
  - 高 → `high`
- 不提供 `关/none`、`minimal`、`max/xhigh`。这些是 provider/model 特定能力，当前 DB 没有模型能力字段，硬做会误导。

风险：不是所有 OpenAI-compatible provider/model 都支持 `reasoning_effort`。用户选择 `低/中/高` 后如果 provider 报错，正常 inline 显示原错，不自动降级；用户可改回 `默认`。

不推荐现在引入官方 provider 包：

- 会新增依赖、provider schema、迁移、UI 分支。
- 当前产品核心是 OpenAI-compatible 自定义 baseURL，已经覆盖 OpenAI/OpenRouter/Qwen/DeepSeek 等。
- 为“思考强度”切 provider 架构太重。

### 6. 模型供应商设置页为什么乱

事实：`ProviderSettings.svelte` 现在把这些东西堆在同一页：

- 添加 provider
- preset
- name/baseURL/apiKey/model/context window
- test connection
- refresh catalog
- 已配置 provider
- provider edit/delete/test
- model list
- model context edit/delete/add

功能全，但层级不清，像后台配置表。

推荐重做为“安静的设置界面”，不改功能。

信息架构：

1. 顶部：一句说明 + `刷新模型目录` 作为次要按钮。
2. `Add model` 卡片：默认只显示 3 个关键项。
   - Provider preset
   - API key
   - 模型 chip picker
3. 模型 chip picker：
   - 默认只选中该 preset 的最新/强模型 1 个 chip。
   - 点 `添加模型` 打开 dropdown，选中后变 chip。
   - chip hover 显示 `×`，可移除。
   - 自定义 provider 支持输入模型名，回车变 chip。
   - 保存时一次创建 provider + 所有 chip 模型；当前模型默认用第一个 chip。
   - 添加阶段不做每个 chip 单独 context 编辑；用 preset 默认 context 或高级统一默认值。
4. Advanced 折叠：
   - Provider name
   - Base URL
   - Context window
   - 自定义 preset 默认展开 advanced；其他 preset 默认收起。
5. 已配置列表：每个 provider 是安静卡片。
   - Header：provider name + masked key + test/edit/delete。
   - Model rows：radio dot + model name + context window + selected badge。
   - Add model row：输入 model name + context window + add。
   - 删除 provider/model 用 inline 二次确认，不用 modal / `confirm()`。

视觉原则：

- 少边框，少按钮，少全大写。
- 主操作只保留一个实心按钮：`保存` / `连接`。
- 其余操作降为 ghost/text。
- 高级字段放原生 `<details>`，默认收起。
- 错误/测试结果用 inline status，不用大块 alert。
- 保存/连接不强制测试；`测试连接` 手动触发，避免 `/models` endpoint 差异阻塞可用配置。
- 半径：外层 14-16px，内部 10-12px。
- shadow 极轻，更多靠 spacing/ring 分层。
- 不引入新动画库。

Provider preset 默认清单：

| Preset | Base URL | 默认模型 | 备选 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.5` | `gpt-5.4-mini`, `gpt-5.4-nano` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-5.5` | `anthropic/claude-sonnet-4.6`, `google/gemini-3.1-pro-preview`, `deepseek/deepseek-v4-pro` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| Qwen / DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-max` | `qwen3.7-plus`, `qwen3.5-flash` |
| Kimi Global | `https://api.moonshot.ai/v1` | `kimi-k2.6` | `moonshot-v1-auto`, `moonshot-v1-128k` |
| Kimi 中国区 | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `moonshot-v1-auto`, `moonshot-v1-128k` |
| MiniMax | `https://api.minimax.io/v1` | `MiniMax-M3` | `MiniMax-M2.7`, `MiniMax-M2.7-highspeed` |
| Z.AI | `https://api.z.ai/api/paas/v4/` | `glm-5.2` | `glm-5.1`, `glm-4.7` |
| StepFun | `https://api.stepfun.ai/v1` | `step-3.7-flash` | `step-3.5-flash` |
| 自定义 | 空 | 空 | 空 |

默认模型优先最新/强模型，不以便宜/快为优先。OpenRouter 使用具体模型 ID，不用 latest alias。

### 7. 图标策略

事实：sidepanel 当前主要用 `@lucide/svelte`，观感常见、传统。

推荐：新增 `phosphor-svelte`，迁移 sidepanel 入口组件图标。

范围：

- 迁移：`entrypoints/sidepanel/App.svelte`、`Composer.svelte`、`ProviderSettings.svelte`、`SessionHistory.svelte`、`SettingsDialog.svelte`、`SourcesBar.svelte`、`Timeline.svelte`。
- 不迁移：`lib/components/ai-elements/*` 通用组件，避免牵扯。
- 发送按钮可用 Phosphor 或自绘 inline SVG，以视觉效果为准。
- 构建后检查 bundle 体积；异常再回退。

## 单轮 Goal 范围

这次按一个 Goal 一轮做完，不拆批次。原因：三块体验彼此相关，同属 sidepanel 产品化收口：Composer、Timeline、streaming、model selector、Provider settings 要统一视觉和状态语义。

### 必做范围

#### Composer interaction polish

范围：sidepanel composer/timeline/view tests。

包含：

- Quick actions 混合交互：总结/翻译直接发送；调研/比价展开 inline intent panel。
- 调研/比价支持可空输入 + 多选已打开标签页；当前页默认参与，tab 行显示 favicon。
- Quick actions 默认单行 4 个紧凑入口，窄宽自然换行，不做固定 2×2 大卡片。
- Tool group 默认折叠策略改为 completed 折叠、running 展开、failed 半展开。
- Tool group 手动展开/折叠状态只保当前 sidepanel runtime，不进 DB。
- Composer 模型 label 只显示 model，provider 放 dropdown。
- 新增 `phosphor-svelte`，迁移 sidepanel 入口组件图标；不迁移 `lib/components/ai-elements/*`。
- taste 风格打磨：更克制、更漂亮、更少日志感。

#### Assistant streaming

范围：offscreen event protocol + sidepanel view derivation + tests。

包含：

- `ToolLoopAgent.generate()` 改为 `ToolLoopAgent.stream()`。
- 写 `message.created/message.appended`。
- `deriveConversation()` 聚合 streaming message。
- 避免 `task.completed` 重复显示 assistant。
- 刷新/重开恢复完整流式文本。
- stop/cancel 保留已生成半截 assistant 文本，但不写假成功、不显示 completed。

#### Model settings + reasoning effort

范围：provider settings / provider store / selected runtime settings / composer model selector。

包含：

- Composer 隐藏 provider，只显示 model。
- 添加 `思考：默认/低/中/高`；默认不传 providerOptions，低/中/高传 `low/medium/high`。
- 用 `settings` 保存 reasoning effort，不改 DB schema。
- `ToolLoopAgent` 调用按需传 `providerOptions.openaiCompatible.reasoningEffort`。
- Provider settings 页面做信息架构和视觉重排。
- Provider settings 去掉 `first model` 概念，改为模型 chip picker。
- Preset 增加 Kimi Global / Kimi 中国区 / MiniMax / Z.AI / StepFun / 自定义。

### 统一验证

新增/更新纯函数和 store 单测：

- streaming append 聚合。
- `task.completed` 去重。
- stop/cancel 不产生假成功。
- reasoning effort settings：默认不传 providerOptions，low/medium/high 会传。
- quick action 行为：直接发送、intent panel、可空输入、多选 tabs prompt。
- tool group 默认折叠策略：completed 折叠、running 展开、failed 半展开。
- provider preset / chip picker：默认模型、multi-chip 保存、自定义 provider。

运行：

- `node --experimental-strip-types scripts/test-sidepanel-view.ts`
- `pnpm run test:unit`
- `pnpm build:chrome`
- `pnpm run test:sidepanel:smoke`
- 真实 sidepanel 视觉截图：empty quick actions、intent panel、collapsed completed tool group、running tool group、streaming assistant、model dropdown、reasoning selector、provider settings。

## 成功标准

- 下方 quick actions 看起来像产品入口，不像普通按钮。
- 工具默认不展开成长日志，用户需要时再点开。
- AI 回复开始更快，逐字/逐块出现。
- Composer 模型区短、清楚，不露 provider 长名。
- 思考强度可选，默认安全不传。
- Provider settings 第一眼只看到关键任务：连接模型、管理模型；高级字段不干扰。
