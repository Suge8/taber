# 使用 OpenAI Responses provider 驱动 ChatGPT Codex

Taber 的 ChatGPT/OpenAI 登录不是 OpenAI API key：请求必须带浏览器 OAuth access token、`ChatGPT-Account-Id`、`OpenAI-Beta: responses=experimental` 和 `originator`。AI SDK 官方 `@ai-sdk/openai` 已负责 Responses 请求形状、prompt/tool-call/usage 映射，所以运行时使用 `createOpenAI(...).responses(modelId)`，不再维护自写 Responses 内容解析器。

仍保留一层薄 fetch shim，职责只有三件：

- 每次请求读取 fresh token 并注入 ChatGPT 订阅端点需要的 headers；
- 脱敏 HTTP 错误响应；
- 对 streaming `/responses`，把 `response.completed`、`response.failed`、`response.incomplete` 映射为 `ReadableStream` close。

Codex 模型和 `supportedReasoningEfforts` 来自 Codex models endpoint。providerOptions 请求 `reasoningSummary: "auto"`，侧边栏只渲染 provider summary，不展示 raw chain-of-thought。

最后一项是现场卡住的根因：ChatGPT Codex backend 可能已经发送 terminal Responses event 但连接继续保持；AI SDK 的 `createEventSourceResponseHandler` / `parseJsonEventStream` 只把底层 `ReadableStream` 当作 SSE 源，OpenAI Responses provider 的 `finish` 在 `TransformStream.flush` 中发出，因此只有源流关闭才会向上游完成。若 socket 不 EOF，`ToolLoopAgent` 会一直等不到 `finish`，也没有 error。回归测试 `scripts/test-codex-runtime.ts` 的 `testTerminalEventClosesHangingStream` 用“已发送 `response.completed` 但 body 不关闭”的流复现并验证 shim 会 cancel 底层 reader。

这不是 WebSocket 路径：AI SDK Responses provider 使用 HTTP SSE（`Accept: text/event-stream`）。WebSocket/Realtime 不适合此处，因为 Taber 需要的是 Responses tool loop 与 ChatGPT 订阅 Codex endpoint 的兼容层，而不是双向实时会话通道。
