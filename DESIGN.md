# Design

Taber 侧边栏视觉事实源的**意图层**。token 具体值的唯一事实源是 `entrypoints/sidepanel/app.css`（`:root` / `[data-theme="dark"]` / `@theme inline`）。本文件只解释代码表达不出的设计意图与取舍，不重复 token 值。

基调：calm precision —— 安静、精确、有呼吸感的现代产品 UI，对标 Linear / Notion / Arc。窄宽度（~360px）密集信息界面，不是 landing。

## 设计原则

- 安静优先：颜色是稀缺资源，只用于语义和主操作。大面积是中性表面。
- 超扁平：靠层次（表面分级 + 1px 边框 + 极淡阴影）建立深度，不靠重投影或渐变。
- 有呼吸感：密集但不拥挤，元素间留间距，避免框套框。
- 丝滑：动效存在但不抢戏，遵守 `prefers-reduced-motion`。
- tabular numbers 用于所有计数、状态、时间值。
- 同心圆角：嵌套元素 `outer = inner + padding`，不同层级 radius 不混用。

## token 去哪看

- 调色板（warm monochrome + 单一 accent，light/dark 两套 OKLCH）：`app.css` 的 `:root` 与 `[data-theme="dark"]`。
- 语义色（danger/success/warn/running）：同上。
- 字体栈、radius、spacing、motion 曲线与时长：`app.css` 的 `@theme inline` 与 `:root`。

## 设计意图（代码看不出的 why）

- 正文色用 `--ink`，不用纯黑：纯黑在暖骨白底上发灰发脏，偏蓝的深墨更干净。
- 阴影 opacity < 0.08、扩散柔和：深度靠表面分级 + 1px line，不靠重投影。禁止 Tailwind 默认 `shadow-md/lg/xl`。
- accent 只给主操作和活跃态：一旦到处用，层次就塌。
- running 用缓慢呼吸（opacity 0.6↔1，~2s）：表达"进行中"而不打扰，reduced-motion 时静止。
- 自动贴底滚动用 AI Elements `Conversation` 内建行为：禁止轮询 / scroll 事件硬算。
- 入场动画用 `transform` / `opacity`，封顶 ~6 项后不再叠加 stagger 延迟：避免长列表拖尾。
- 不展示 raw chain-of-thought / `<think>`：只展示 assistant 最终回答与工具证据。

## 主题

默认 follow system，可切 light/dark/system，用 `data-theme` 落到 `documentElement`。
