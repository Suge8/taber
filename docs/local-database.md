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
- `skills` (db v2; agent-authored site skills exposed as /skills/*.md via the fs tool, see ADR 0015/0016)
- `files` (db v3; per-session /workspace files: uploads and agent outputs)

db v4 is a repair migration: skills whose names collide on the /skills/<slug>.md path (written before slug uniqueness was enforced) get a numeric name suffix; the newest keeps its name, nothing is deleted.

Model records include `contextWindowTokens`; runtime context budgeting reads the saved model record, not provider metadata. Provider, credential, model and selected-model writes go through `lib/provider-config-flow.ts` transactions.

Retention:

- Default: keep latest 30 non-pinned sessions.
- Pinned sessions are never pruned.
- `settings.sessionRetentionLimit = "unlimited"` disables pruning.
- Session pruning deletes linked `toolRuns`, `agentEvents`, and `files` in one transaction.

Sidepanel and Agent recovery:

- On load, sidepanel opens Dexie and reads the latest session snapshot.
- Conversation, tool timeline, sources, image preview, and model context are rebuilt from the Agent event projection over `agentEvents`.
- `messages` is intentionally not a table; `agentEvents` is the single history source.
- Long context is compacted into append-only `context.compacted` events.
