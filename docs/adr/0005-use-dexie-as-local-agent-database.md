# 使用 Dexie 作为本地 Agent 数据库

Taber 使用 Dexie/IndexedDB 作为单一本地数据源，保存供应商配置、模型配置、会话、消息和工具运行记录。`chrome.storage.local` 更适合小配置，但会让 API key、会话和工具日志分裂到多个存储；统一到 Dexie 能减少同步、迁移和状态分支。
