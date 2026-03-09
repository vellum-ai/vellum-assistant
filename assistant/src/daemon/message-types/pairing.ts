// Pairing approval and approved-device management types.

// === Client → Server ===

export interface PairingApprovalResponse {
  type: "pairing_approval_response";
  pairingRequestId: string;
  decision: "approve_once" | "always_allow" | "deny";
}

export interface ApprovedDevicesList {
  type: "approved_devices_list";
}

export interface ApprovedDeviceRemove {
  type: "approved_device_remove";
  hashedDeviceId: string;
}

export interface ApprovedDevicesClear {
  type: "approved_devices_clear";
}

// === Server → Client ===

export interface PairingApprovalRequest {
  type: "pairing_approval_request";
  pairingRequestId: string;
  deviceId: string;
  deviceName: string;
}

export interface ApprovedDevicesListResponse {
  type: "approved_devices_list_response";
  devices: Array<{
    hashedDeviceId: string;
    deviceName: string;
    lastPairedAt: number;
  }>;
}

export interface ApprovedDeviceRemoveResponse {
  type: "approved_device_remove_response";
  success: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _PairingClientMessages =
  | PairingApprovalResponse
  | ApprovedDevicesList
  | ApprovedDeviceRemove
  | ApprovedDevicesClear;

export type _PairingServerMessages =
  | PairingApprovalRequest
  | ApprovedDevicesListResponse
  | ApprovedDeviceRemoveResponse;
