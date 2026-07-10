# 会话日志调试

Taber 的全部运行过程以 append-only 事件流存在扩展的 IndexedDB（数据库 `taber`，`agentEvents` 表）。诊断"agent 为什么笨/卡住"时，事件流是唯一事实源。

## 事件类型速览

- `task.started` / `task.completed` / `task.failed` / `task.cancelled`：任务生命周期
- `tool.input.started` / `tool.input.appended` / `tool.input.completed`：模型生成工具入参
- `tool.started` / `tool.completed` / `tool.failed`：工具执行。**只有 `tool.input.*` 而无后续事件 = 入参未通过校验**（AI SDK 直接打回模型，不执行工具）；这类失败会以 `tool.failed`（含 error，无 durationMs）记录
- `reasoning.*` / `message.*`：模型思考与回复
- `context.compacted`：上下文压缩

## 途径一：用户导出（覆盖任意浏览器）

侧边栏打开目标会话 → 设置 → 偏好 → 诊断 → “导出会话日志”（导出当前会话）→ 得到 `taber-session-<id>-<time>.jsonl`。每行一个事件；超长字符串与截图 dataUrl 已截断（`lib/session-export.ts`）。把文件交给 agent 直接分析。

## 途径二：CDP dump（开发闭环，无需用户操作）

前提：一个开着调试端口且装了 Taber 的浏览器。两种来源：

- 运行时冒烟浏览器：`pnpm build:chrome && TABER_HEADED=1 pnpm run test:ci:runtime` 起的实例（CDP `http://127.0.0.1:9258`），或用 `scripts/runtime-browser.mjs` 的 `prepareRuntimeBrowser` 自起
- 任意 `--remote-debugging-port` 的浏览器（如 browser-dev 实例 `9333`）+ 手动 load `.output/chrome-mv3`

用法：

```bash
# 列出所有会话
node --experimental-strip-types scripts/dump-session-events.ts

# dump 指定会话到 .tmp/taber-session-<id>-<time>.jsonl
node --experimental-strip-types scripts/dump-session-events.ts 3

# 指定 CDP 端口（默认依次尝试 9258、9333）
TABER_CDP_ORIGIN=http://127.0.0.1:9333 node --experimental-strip-types scripts/dump-session-events.ts
```

注意：dump 只读取 CDP 所连实例自己的 IndexedDB。用户日常浏览器里的历史会话拿不到，走途径一。

## 常见症状 → 事件特征

- 工具在 UI 长期"等待中"（旧版本）：入参校验失败。看 `tool.input.completed` 的 input 与紧随的 `tool.failed` error
- navigate 反复超时：`navigation.status: "timeout"` 属降级成功，`tab.url` 已在目标域即页面可用，不应重试
- 模型反复 snapshot/检查：对照 `tool.completed` 的 output 看快照是否包含目标元素（默认 limit 30）
- `tool.input.appended` 在完整 JSON 后继续出现垃圾，或在 JSON 字符串外连续输出超过 512 个结构空白：模型工具参数生成退化。字符串内容内的空白不触发该规则
- reasoning/message 连续输出超过 512 个空白字符，或单 step 生成内容超过 4,000,000 字符：流守护会中止上游并记录 `task.failed`
- 180 秒没有任何流事件：上游连接停滞。流守护会中止请求并记录 `task.failed`
- `task.failed` 包含 `timed out`：单 step 超过 5 分钟或整个 Agent 执行超过 30 分钟
- `task.failed` 包含 `tool-loop limit`：Agent 达到 20-step 上限但没有生成最终回复；这是明确失败，不是假完成
