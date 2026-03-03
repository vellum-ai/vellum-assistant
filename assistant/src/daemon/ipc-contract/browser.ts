// Browser interaction types.

export interface BrowserCDPRequest {
  type: "browser_cdp_request";
  sessionId: string;
}

export interface BrowserCDPResponse {
  type: "browser_cdp_response";
  sessionId: string;
  success: boolean;
  declined?: boolean;
}

export interface BrowserInteractiveMode {
  type: "browser_interactive_mode";
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
}

export interface BrowserInteractiveModeChanged {
  type: "browser_interactive_mode_changed";
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
  reason?: string;
  message?: string;
}

export interface BrowserHandoffRequest {
  type: "browser_handoff_request";
  sessionId: string;
  surfaceId: string;
  reason: "auth" | "checkout" | "captcha" | "custom";
  message: string;
  bringToFront?: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _BrowserClientMessages =
  | BrowserCDPResponse
  | BrowserInteractiveMode;

export type _BrowserServerMessages =
  | BrowserCDPRequest
  | BrowserInteractiveModeChanged
  | BrowserHandoffRequest;
