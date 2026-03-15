// Host bash proxy types.
// Enables proxying shell commands to the desktop client (host machine)
// when running as a managed assistant.

// === Server → Client ===

export interface HostBashRequest {
  type: "host_bash_request";
  requestId: string;
  sessionId: string;
  command: string;
  working_dir?: string;
  timeout_seconds?: number;
  /** Extra environment variables to inject into the subprocess (e.g. VELLUM_UNTRUSTED_SHELL). */
  env?: Record<string, string>;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostBashServerMessages = HostBashRequest;
