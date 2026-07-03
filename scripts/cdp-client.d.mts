export type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
};

export function fetchJson(url: string): Promise<any>;
export function hasCdpEndpoint(target: Record<string, any>): boolean;
export function connectTarget(target: Record<string, any>): Promise<CdpClient>;
export function connectCdp(webSocketUrl: string): Promise<CdpClient>;
export function evaluate(cdp: CdpClient, expression: string): Promise<any>;
export function evaluateStable(cdp: CdpClient, expression: string): Promise<any>;
export function readTargets(cdpOrigin: string): Promise<Record<string, any>[]>;
export function waitForTarget(cdpOrigin: string, match: (target: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>;
export function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs?: number, errorMessage?: string): Promise<T>;
export function delay(ms: number): Promise<void>;
