// Host computer-use proxy types.
// Enables proxying computer-use actions (click, type, screenshot, etc.)
// to the desktop client when running as a managed assistant.

// === Server → Client ===

export interface HostCuRequest {
  type: "host_cu_request";
  requestId: string;
  conversationId: string;
  toolName: string; // "computer_use_click", "computer_use_type_text", etc.
  input: Record<string, unknown>;
  stepNumber: number;
  reasoning?: string;
}

export interface HostCuCancelRequest {
  type: "host_cu_cancel";
  requestId: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostCuServerMessages = HostCuRequest | HostCuCancelRequest;
