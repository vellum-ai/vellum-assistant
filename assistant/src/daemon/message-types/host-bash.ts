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
}

// === Client → Server ===

export interface HostBashResponse {
  type: "host_bash_response";
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostBashClientMessages = HostBashResponse;

export type _HostBashServerMessages = HostBashRequest;
