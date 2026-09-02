/**
 * Ambient types for `@novnc/novnc`, which ships no declarations.
 *
 * Covers only the surface `domains/chat/desktop/desktop-session.ts` uses. The
 * package's `exports` field maps the bare specifier to `core/rfb.js`, so the
 * class is the default export of `@novnc/novnc` itself.
 *
 * Reference: https://github.com/novnc/noVNC/blob/master/docs/API.md
 */
declare module "@novnc/novnc" {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    clipboard: CustomEvent<{ text: string }>;
  }

  export default class RFB {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RFBOptions,
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(): void;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
    ): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
    ): void;
  }
}
