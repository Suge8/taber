# Local database

Dexie database name: `taber`.

Tables:

- `providers`
- `providerCredentials`
- `models`
- `sessions`
- `toolRuns`
- `agentEvents`
- `settings`

Model records include `contextWindowTokens`; runtime context budgeting reads the saved model record, not provider metadata. Provider, credential, model and selected-model writes go through `lib/provider-config-flow.ts` transactions.

Retention:

- Default: keep latest 30 non-pinned sessions.
- Pinned sessions are never pruned.
- `settings.sessionRetentionLimit = "unlimited"` disables pruning.
- Session pruning deletes linked `toolRuns` and `agentEvents` in one transaction.

Sidepanel and Agent recovery:

- On load, sidepanel opens Dexie and reads the latest session snapshot.
- Conversation, tool timeline, sources, image preview, and model context are rebuilt from the Agent event projection over `agentEvents`.
- `messages` is intentionally not a table; `agentEvents` is the single history source.
- Long context is compacted into append-only `context.compacted` events.
