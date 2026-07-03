export type MaintenanceModeInfo = {
  enabled?: boolean;
};

/**
 * Probe-confirmed daemon health, written by the lifecycle service's
 * healthz probes. Distinct from `reachable`: `reachable` is the acute
 * connectivity signal (flipped optimistically on SSE drops / failed
 * requests, consumed by the chat overlay), while `health` only ever
 * reflects a completed probe — so the status banner doesn't flash on
 * transient bounces. For local / self-hosted assistants the service
 * maintains it with a steady heartbeat; for platform-hosted assistants
 * the centralized operational-status API is the health surface and
 * this field is only touched by event-driven probes.
 */
export type LocalAssistantHealth =
  | "healthy"
  | "unhealthy"
  | "unreachable"
  | "upgrading"
  | "sleeping"
  | "starting"
  | "crashed";

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
  | { kind: "self_hosted"; health?: LocalAssistantHealth }
  | {
      kind: "active";
      isLocal: boolean;
      maintenanceMode?: MaintenanceModeInfo;
      reachable?: boolean;
      health?: LocalAssistantHealth;
    }
  /**
   * `transient: true` marks a transport-shaped failure (device offline,
   * network flapping after sleep/wake) rather than a server-reported
   * error. The lifecycle service auto-retries these with backoff and
   * on network-online signals; the chat page renders them with
   * reconnecting copy instead of a terminal error.
   */
  | { kind: "error"; message: string; transient?: boolean };
