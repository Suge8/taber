# 同一时间只运行一个全局 Agent 任务

Taber 同一时间只运行一个浏览器 Agent 任务。每窗口或每标签页并发会让 active tab、debugger、userScripts、事件日志和侧边栏恢复产生竞态；全局单任务牺牲并行能力，但代码最少、状态边界最清楚，也更符合有人监督的使用方式。
