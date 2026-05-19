// Host camera proxy types.
// Enables a request-scoped, one-shot webcam snapshot on a connected desktop
// client. Raw image bytes return only to the awaiting proxy and are summarized
// before the agent sees the tool result.

export interface HostCameraInput {
  /** Optional question/instruction to guide the image summary. */
  prompt?: string;
  /** Optional target client id when multiple desktop clients are connected. */
  target_client_id?: string;
}

// === Server -> Client ===

export interface HostCameraRequest {
  type: "host_camera_request";
  requestId: string;
  conversationId: string;
  toolName: "describe_camera_once";
  input: HostCameraInput;
  targetClientId?: string;
}

export interface HostCameraCancel {
  type: "host_camera_cancel";
  requestId: string;
  conversationId: string;
  targetClientId?: string;
}

// === Result payload (HTTP /v1/host-camera-result body) ===

export interface HostCameraResultPayload {
  requestId: string;
  imageBase64?: string;
  mediaType?: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  error?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostCameraServerMessages = HostCameraRequest | HostCameraCancel;
