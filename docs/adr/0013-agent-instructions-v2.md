# Agent Instructions V2：更短的策略层提示词

Taber 的浏览器 Agent 指令升级到 `AGENT_INSTRUCTIONS_VERSION = 2`。V2 把 system prompt 收敛为策略层：权限层级、自主执行、安全边界、工具选择和输出格式；工具自己的参数、限制和证据形态放回 tool description。代码已强制的 target tab 锁定、ref 失效、直接导航拦截和 reasoning 过滤，不再在 system prompt 重复细节。

模型上下文显式标记权威性：浏览器上下文和历史工具证据使用 `authority="untrusted"`，压缩摘要使用 `authority="model-generated"`。用户请求仍作为独立任务目标呈现，避免网页内容、工具输出或历史摘要被误当成新指令执行。

每个 `task.started` 事件记录 `instructionsVersion`，来源只使用 `AGENT_INSTRUCTIONS_VERSION` 常量，便于回溯任务行为和排查回归。

边界：本次不改变工具执行协议、不保留旧 prompt 兼容层、不新增生产依赖。若 V2 行为回归，回滚方式是恢复 `lib/agent-instructions.ts` 和相关上下文标记/事件版本改动，或将版本常量随回滚代码恢复；历史事件中的版本号可用于对比 V1/V2 任务。
