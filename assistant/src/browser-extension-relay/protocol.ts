/**
 * Protocol types for the Chrome extension relay bridge.
 *
 * Messages flow:
 *   Assistant → ExtensionRelayServer → WebSocket → Chrome Extension → Tab (JS eval)
 */

export interface CookieSpec {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

/**
 * Command sent from the server to the extension over WebSocket.
 */
export interface ExtensionCommand {
  id: string; // UUID
  action:
    | 'evaluate'
    | 'navigate'
    | 'get_cookies'
    | 'set_cookie'
    | 'screenshot'
    | 'find_tab'
    | 'new_tab';
  tabId?: number;
  code?: string;     // for evaluate
  url?: string;      // for navigate / find_tab / new_tab
  domain?: string;   // for get_cookies
  cookie?: CookieSpec;
  timeoutMs?: number;
}

/**
 * Response sent from the extension back to the server.
 */
export interface ExtensionResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  tabId?: number;
}

/**
 * Periodic heartbeat from the extension to the server.
 */
export interface ExtensionHeartbeat {
  type: 'heartbeat';
  extensionVersion: string;
  connectedTabs: number;
}

/**
 * Any message received from the extension (heartbeat or command response).
 */
export type ExtensionInboundMessage = ExtensionHeartbeat | ExtensionResponse;
