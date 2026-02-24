// Browser interaction types.

export interface BrowserFrame {
  type: 'browser_frame';
  sessionId: string;
  surfaceId: string;
  frame: string; // base64 JPEG
  metadata?: { offsetTop: number; pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number; timestamp: number };
}

export interface BrowserCDPRequest {
  type: 'browser_cdp_request';
  sessionId: string;
}

export interface BrowserCDPResponse {
  type: 'browser_cdp_response';
  sessionId: string;
  success: boolean;
  declined?: boolean;
}

export interface BrowserUserClick {
  type: 'browser_user_click';
  sessionId: string;
  surfaceId: string;
  x: number;
  y: number;
  button?: 'left' | 'right';
  doubleClick?: boolean;
}

export interface BrowserUserScroll {
  type: 'browser_user_scroll';
  sessionId: string;
  surfaceId: string;
  deltaX: number;
  deltaY: number;
  x: number;
  y: number;
}

export interface BrowserUserKeypress {
  type: 'browser_user_keypress';
  sessionId: string;
  surfaceId: string;
  key: string;
  modifiers?: string[];
}

export interface BrowserInteractiveMode {
  type: 'browser_interactive_mode';
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
}

export interface BrowserInteractiveModeChanged {
  type: 'browser_interactive_mode_changed';
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
  reason?: string;
  message?: string;
}

export interface BrowserHandoffRequest {
  type: 'browser_handoff_request';
  sessionId: string;
  surfaceId: string;
  reason: 'auth' | 'checkout' | 'captcha' | 'custom';
  message: string;
  bringToFront?: boolean;
}
