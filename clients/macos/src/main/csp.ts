import { session } from "electron";

// 'unsafe-inline' in script-src: required because sandboxed srcdoc iframes
// (dynamic-page-surface, app-viewer) inherit the parent CSP and their
// injected bridge/storage scripts are inline. The sandbox attribute is the
// primary isolation boundary for that content.
//
// ws://localhost / ws://127.0.0.1 in connect-src: the self-hosted gateway's
// WebSocket endpoints (/v1/stt/stream dictation partials, /v1/live-voice).
// HTTP gateway traffic rides the app:// protocol forward in main and stays
// within 'self', but WebSocket upgrades can't take that path — the local
// loopback ingress is the one shape a static CSP can allowlist. A REMOTE
// self-hosted ingress (e.g. an ngrok wss:// URL) still can't be — those
// connections need the planned proxy-through-main follow-up.
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' blob: data: https://*.vellum.ai wss://*.vellum.ai https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.elevenlabs.io https://api.deepgram.com ws://localhost:* ws://127.0.0.1:*",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const installCsp = (): void => {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["app://*/*"] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [CSP_POLICY],
        },
      });
    },
  );
};
