# 使用 OpenAI-compatible 供应商形态

Taber 将模型供应商统一为 OpenAI-compatible 配置：`name`、`baseURL`、`apiKey`、`model`。AI SDK v6 已提供 `@ai-sdk/openai-compatible` 和 `createOpenAICompatible`，所以不需要为每家供应商手写 adapter。代价是部分原生供应商特性会被抹平，但配置和代码最少。
