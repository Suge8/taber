import { projectAgentEvents } from './agent-event-projection.ts';
import type { AgentEvent } from './db.ts';

export type TaskState = 'idle' | 'running';

type EventLike = {
  type: string;
  payload: unknown;
  id?: number;
  sessionId?: number;
  createdAt?: number;
};

export function deriveTaskState(events: EventLike[]): TaskState {
  return projectAgentEvents(events.map(toAgentEvent)).taskState;
}

function toAgentEvent(event: EventLike, index: number): AgentEvent {
  return {
    id: readNumber(event.id) ?? index + 1,
    sessionId: readNumber(event.sessionId) ?? 0,
    type: event.type,
    payload: event.payload,
    createdAt: readNumber(event.createdAt) ?? index + 1,
  };
}

function readNumber(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}
