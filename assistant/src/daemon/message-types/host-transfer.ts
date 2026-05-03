// Host transfer proxy types.
// Enables bidirectional file transfer between sandbox and host machine
// when running as a managed assistant.

// === Server → Client ===

export interface HostTransferToHostRequest {
  type: "host_transfer_request";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
  direction: "to_host";
  transferId: string;
  destPath: string;
  sizeBytes: number;
  sha256: string;
  overwrite: boolean;
}

export interface HostTransferToSandboxRequest {
  type: "host_transfer_request";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
  direction: "to_sandbox";
  transferId: string;
  sourcePath: string;
}

export type HostTransferRequest =
  | HostTransferToHostRequest
  | HostTransferToSandboxRequest;

export interface HostTransferCancelRequest {
  type: "host_transfer_cancel";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostTransferServerMessages =
  | HostTransferRequest
  | HostTransferCancelRequest;
