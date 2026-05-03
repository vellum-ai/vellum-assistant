// Host file proxy types.
// Enables proxying file operations to the desktop client (host machine)
// when running as a managed assistant.

// === Server → Client ===

export interface HostFileReadRequest {
  type: "host_file_request";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
  operation: "read";
  path: string;
  offset?: number;
  limit?: number;
}

export interface HostFileWriteRequest {
  type: "host_file_request";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
  operation: "write";
  path: string;
  content: string;
}

export interface HostFileEditRequest {
  type: "host_file_request";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
  operation: "edit";
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type HostFileRequest =
  | HostFileReadRequest
  | HostFileWriteRequest
  | HostFileEditRequest;

export interface HostFileCancelRequest {
  type: "host_file_cancel";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostFileServerMessages = HostFileRequest | HostFileCancelRequest;
