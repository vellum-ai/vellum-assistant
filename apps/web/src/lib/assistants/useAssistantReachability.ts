// TODO: port from platform
export type ReachabilityState = { phase: "connected" | "connecting" | "failed"; attempt: number; isPodWaking: boolean; detail: string | null; lastServerState: ConnectionServerState | null; };
export type ConnectionServerState = "ok" | "crash_loop" | "unknown";
export const MAX_ATTEMPTS = 12;
export function useAssistantReachability() { return { phase: "connected" as const, attempt: 0, isPodWaking: false, detail: null, lastServerState: null } as ReachabilityState; }
