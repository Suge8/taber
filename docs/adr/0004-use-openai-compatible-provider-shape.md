# 模型供应商形态

Taber 保留四类 provider：

- `openaiApiKey`：OpenAI API key。运行时使用 `@ai-sdk/openai` Responses provider；模型 picker 以当前 key/baseURL 的 `/v1/models` 为主表，`models.dev` 只 left join 补齐能力元数据；目录未知的账号模型仍显示，使用默认 context window、空 reasoning 能力集。
- `openaiCodex`：ChatGPT/Codex 登录。运行时使用 `@ai-sdk/openai` Responses provider + 最薄鉴权/流结束 shim；模型和 reasoning effort 来自 Codex models endpoint。
- `xaiSub`：xAI/Grok 订阅登录。运行时使用 `@ai-sdk/openai` Responses provider + OAuth bearer token fetch shim；模型清单先收敛为内置 Grok subscription 模型定义。
- `openaiCompatible`：其他 OpenAI-compatible 服务。运行时使用 `@ai-sdk/openai-compatible`。

模型能力以 `Model` 记录为单一事实源：`contextWindowTokens`、`supportedReasoningEfforts`、`defaultReasoningEffort`。UI 只展示当前模型支持的 reasoning effort；运行时不静默降级，不支持就报错。
