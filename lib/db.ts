import Dexie, { type EntityTable } from 'dexie';

export const DEFAULT_SESSION_LIMIT = 30;
export const UNLIMITED_SESSION_RETENTION = 'unlimited';
export const sessionRetentionLimitKey = 'sessionRetentionLimit';

export type ProviderKind = 'openaiCompatible' | 'openaiApiKey' | 'openaiCodex' | 'xaiSub';

export type Provider = {
  id: number;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  createdAt: number;
  updatedAt: number;
};

export type ProviderCredentialKind = 'apiKey' | 'openaiCodexOAuth' | 'xaiSubOAuth';

export type ProviderCredential = {
  providerId: number;
  kind: ProviderCredentialKind;
  value: unknown;
  updatedAt: number;
};

export type Model = {
  id: number;
  providerId: number;
  name: string;
  contextWindowTokens: number;
  displayName?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  priority?: number;
  visibility?: string;
  supportedInApi?: boolean;
  metadataFetchedAt?: number;
  unavailable?: boolean;
};

export type Session = {
  id: number;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ToolRun = {
  id: number;
  sessionId: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  durationMs?: number;
  createdAt: number;
};

export type AgentEvent = {
  id: number;
  sessionId: number;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type Setting = {
  key: string;
  value: unknown;
};

export type SessionRetentionLimit = number | typeof UNLIMITED_SESSION_RETENTION;

export type SessionSnapshot = {
  session: Session;
  toolRuns: ToolRun[];
  agentEvents: AgentEvent[];
};

export type SessionListItem = Pick<Session, 'id' | 'title' | 'pinned' | 'createdAt' | 'updatedAt'>;

export class TaberDatabase extends Dexie {
  providers!: EntityTable<Provider, 'id'>;
  providerCredentials!: EntityTable<ProviderCredential, 'providerId'>;
  models!: EntityTable<Model, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  toolRuns!: EntityTable<ToolRun, 'id'>;
  agentEvents!: EntityTable<AgentEvent, 'id'>;
  settings!: EntityTable<Setting, 'key'>;

  constructor() {
    super('taber');
    this.version(1).stores({
      providers: '++id, kind, name',
      providerCredentials: '&providerId, kind',
      models: '++id, providerId, name',
      sessions: '++id, updatedAt, pinned',
      toolRuns: '++id, sessionId, createdAt, toolName',
      agentEvents: '++id, sessionId, createdAt, type',
      settings: '&key',
    });
  }
}

export const database = new TaberDatabase();

export async function initializeDatabase() {
  return database.open();
}

export async function createSession(options: { title?: string; pinned?: boolean; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const id = await database.sessions.add({
    title: options.title ?? 'New session',
    pinned: options.pinned ?? false,
    createdAt: now,
    updatedAt: now,
  });

  await pruneOldSessions();
  return requireSession(Number(id));
}

export async function appendToolRun(record: {
  sessionId: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  durationMs?: number;
  now?: number;
}) {
  const createdAt = record.now ?? Date.now();
  return database.transaction('rw', database.sessions, database.toolRuns, async () => {
    await requireSession(record.sessionId);
    const id = await database.toolRuns.add({
      sessionId: record.sessionId,
      toolName: record.toolName,
      input: record.input,
      output: record.output,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      createdAt,
    });
    await touchSession(record.sessionId, createdAt);
    return Number(id);
  });
}

export async function appendAgentEvent(record: {
  sessionId: number;
  type: string;
  payload: unknown;
  now?: number;
}) {
  const createdAt = record.now ?? Date.now();
  return database.transaction('rw', database.sessions, database.agentEvents, async () => {
    await requireSession(record.sessionId);
    const id = await database.agentEvents.add({
      sessionId: record.sessionId,
      type: record.type,
      payload: record.payload,
      createdAt,
    });
    await touchSession(record.sessionId, createdAt);
    return Number(id);
  });
}

export async function readSessionSnapshot(sessionId: number): Promise<SessionSnapshot> {
  const session = await requireSession(sessionId);
  const [toolRuns, agentEvents] = await Promise.all([
    database.toolRuns.where('sessionId').equals(sessionId).sortBy('createdAt'),
    database.agentEvents.where('sessionId').equals(sessionId).sortBy('createdAt'),
  ]);

  return { session, toolRuns, agentEvents };
}

export async function readLatestSessionSnapshot() {
  const session = await database.sessions.orderBy('updatedAt').last();
  return session ? readSessionSnapshot(session.id) : undefined;
}

export async function listSessions(): Promise<SessionListItem[]> {
  return database.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function readSessionRetentionLimit(): Promise<SessionRetentionLimit> {
  const setting = await database.settings.get(sessionRetentionLimitKey);
  if (!setting) return DEFAULT_SESSION_LIMIT;
  return normalizeSessionRetentionLimit(setting.value);
}

export async function setSessionRetentionLimit(limit: SessionRetentionLimit) {
  normalizeSessionRetentionLimit(limit);
  await database.settings.put({ key: sessionRetentionLimitKey, value: limit });
  await pruneOldSessions(limit);
}

export async function pruneOldSessions(limit?: SessionRetentionLimit) {
  const retentionLimit = limit ?? (await readSessionRetentionLimit());
  if (retentionLimit === UNLIMITED_SESSION_RETENTION) return [];

  const sessions = await database.sessions.toArray();
  const sessionIds = selectPrunableSessionIds(sessions, retentionLimit);
  if (sessionIds.length === 0) return [];

  await database.transaction(
    'rw',
    database.sessions,
    database.toolRuns,
    database.agentEvents,
    async () => {
      await Promise.all([
        database.toolRuns.where('sessionId').anyOf(sessionIds).delete(),
        database.agentEvents.where('sessionId').anyOf(sessionIds).delete(),
      ]);
      await database.sessions.bulkDelete(sessionIds);
    },
  );

  return sessionIds;
}

export function selectPrunableSessionIds(sessions: Session[], limit: SessionRetentionLimit) {
  if (limit === UNLIMITED_SESSION_RETENTION) return [];

  return sessions
    .filter((session) => !session.pinned)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id - left.id)
    .slice(limit)
    .map((session) => session.id);
}

function normalizeSessionRetentionLimit(value: unknown): SessionRetentionLimit {
  if (value === UNLIMITED_SESSION_RETENTION) return value;
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`Invalid session retention limit: ${String(value)}`);
}

async function touchSession(sessionId: number, updatedAt: number) {
  const updated = await database.sessions.update(sessionId, { updatedAt });
  if (updated === 0) throw new Error(`Session not found: ${sessionId}`);
}

async function requireSession(sessionId: number) {
  const session = await database.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}
