# 0018. 允许任务从不可操作标签页启动

日期：2026-07-10

状态：已接受（修订 ADR 0011 的启动与失效规则）

## 背景

纯问答不需要网页；用户也常从新标签页或 `chrome://` 页面发起任务。启动时强制要求 http/https 会阻断这些任务，也无法让 Agent 先启动再导航。

## 决策

1. 任务锁定侧边栏所属窗口当时的 active tab；只要求 tab 存在，不要求 URL 可操作。
2. target 暂时不可操作或缺少页面访问权限时，页面工具明确失败，但任务继续；Agent 可用 `navigate.open` 或 `navigate.switchTab` 恢复。
3. target 被关闭或不存在仍是 fatal error；绝不回退到其他 active tab。
4. target 只通过 `navigate.switchTab`、`navigate.open target:"new"` 或侧边栏用户确认切换。

## 影响

任务启动与页面能力解耦，同时保留单一 target 和不误操作其他标签页的边界。
