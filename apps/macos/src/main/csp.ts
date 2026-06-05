import { session } from "electron";

// Self-hosted live-voice WS connects to an arbitrary ingress URL that a
// static CSP can't allowlist — follow-up will proxy through main or
// extend connect-src dynamically.
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.vellum.ai wss://*.vellum.ai https://*.ingest.sentry.io",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
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
