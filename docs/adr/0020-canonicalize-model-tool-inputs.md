# 0020. 模型工具输入先规范化，运行策略由宿主注入

日期：2026-07-12

状态：已接受

## 背景

模型会给扁平 JSON Schema 的可选字段填入占位值，例如把 `minimum: 1` 的 `tabId` 填成 `1`，即使当前 action 不使用该字段。若执行层把占位值当作意图，会制造无效工具调用和额外模型轮次。

项目需兼容 OpenAI-compatible provider；其工具 Schema 稳定性测试禁止 `oneOf/anyOf/allOf`，因此不使用组合 Schema 表达 action 联合，也不增加 provider 专用适配器。

## 决策

1. 模型只表达任务意图。`targetTabId`、窗口、前台模式和工具总超时由 AgentHost 注入，不暴露给模型。
2. 扁平 Schema 只负责供应商兼容；每个工具在唯一入口按 action 生成 canonical input（规范输入），丢弃无业务语义的已知占位字段。自定义 validator 也必须返回 canonical input，不能接受 schema 隐藏的宿主策略字段。
3. `navigate` 只有 `switchTab/closeTab` 接受 `tabId`；其他 action 及其他顶层工具始终使用任务 target。Background Broker 继续独立验证 target 安全边界。
4. `browser` 固定使用宿主页面操作超时，`browserRepl` 固定使用宿主运行总预算。每次 REPL 创建独立取消域：总预算到期、任务取消或运行清理都会 abort 沙箱及所有在途页面命令。`waitFor` 等 helper 的局部等待时长是页面操作意图，但实际执行时不得超过剩余总预算。
5. 可预期、可恢复的工具失败返回 `{ ok:false, code, message, retryHint }`；target 消失、任务中止和程序不变量破坏仍抛异常。
6. `browserRepl` 的单表达式按 REPL 语义自动返回；多语句代码应显式 return。若没有返回值，则保留最后一次 helper 证据；仍无证据时返回 `NO_EVIDENCE`，不得假成功。
7. 侧边栏按错误码展示用户语义；原始技术错误只放在可展开详情中。

## 影响

- 保留 6 个顶层工具，不通过拆工具扩大选择面。
- 不静默切换 target，不削弱 Background Broker 的 fail-closed（失败即阻止）边界。
- 模型接口更小，工具轮次和最长等待上界下降。
- 新增 `runtime.configured` 诊断事件，记录非秘密的 provider/model、推理强度和工具 Schema 版本。
