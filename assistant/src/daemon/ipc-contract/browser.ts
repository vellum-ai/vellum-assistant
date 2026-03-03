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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _BrowserClientMessages = BrowserCDPResponse;

export type _BrowserServerMessages = BrowserCDPRequest;
