import { session } from "electron";

// 'unsafe-inline' in script-src: required because sandboxed srcdoc iframes
// (dynamic-page-surface, app-viewer) inherit the parent CSP and their
// injected bridge/storage scripts are inline. The sandbox attribute is the
// primary isolation boundary for that content.
//
// Self-hosted live-voice WS connects to an arbitrary ingress URL that a
// static CSP can't allowlist — follow-up will proxy through main or
// extend connect-src dynamically.
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' blob: data: https://*.vellum.ai wss://*.vellum.ai https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.elevenlabs.io https://api.deepgram.com",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "font-src 'self'",
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
