export type MaintenanceModeInfo = {
  enabled?: boolean;
};

/**
 * Discriminated union describing every phase the assistant can be in,
 * from initial load through active use and error states. Drives
 * top-level conditional rendering across the app shell and chat page.
 *
 * `loading` is the client-only initial phase before any `/assistant/`
 * response has resolved. Every other kind maps from
 * `resolveAssistantLifecycleState` of a server response plus
 * client-managed recovery state (retry exhaustion → `error`).
 */
export type AssistantState =
  | { kind: "loading" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "self_hosted" }
  | { kind: "active"; isLocal: boolean; maintenanceMode?: MaintenanceModeInfo; reachable?: boolean }
  /**
   * `transient: true` marks a transport-shaped failure (device offline,
   * network flapping after sleep/wake) rather than a server-reported
   * error. The lifecycle service auto-retries these with backoff and
   * on network-online signals; the chat page renders them with
   * reconnecting copy instead of a terminal error.
   */
  | { kind: "error"; message: string; transient?: boolean };
