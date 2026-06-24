import { session } from "electron";

// Root hostname (leading dot, e.g. ".vellum.ai") injected at build time via
// electron-vite `define` from VITE_ROOT_HOSTNAME — the same var the web bundle
// reads. Falls back to the production default when unset (e.g. under `bun
// test`, which doesn't run the bundler).
declare const __VELLUM_ROOT_HOSTNAME__: string;
const ROOT_HOSTNAME =
  typeof __VELLUM_ROOT_HOSTNAME__ === "string"
    ? __VELLUM_ROOT_HOSTNAME__
    : ".vellum.ai";
// Wildcard host for CSP source lists, e.g. "*.vellum.ai".
const WILDCARD_HOST = `*${ROOT_HOSTNAME}`;

// 'unsafe-inline' in script-src: required because sandboxed srcdoc iframes
// (dynamic-page-surface, app-viewer) inherit the parent CSP and their
// injected bridge/storage scripts are inline. The sandbox attribute is the
// primary isolation boundary for that content.
//
// https://${WILDCARD_HOST} in script-src: the session-replay recorder script is
// served first-party from the platform origin (`/_sr/cdn/...`) and loads as a
// regular <script>. Ingest is already covered by connect-src and the recorder
// worker by `worker-src ... blob:`, so this is the only directive that needs it.
//
// ws://localhost / ws://127.0.0.1 in connect-src: the self-hosted gateway's
// WebSocket endpoints (/v1/stt/stream dictation partials, /v1/live-voice).
// HTTP gateway traffic rides the app:// protocol forward in main and stays
// within 'self', but WebSocket upgrades can't take that path — the local
// loopback ingress is the one shape a static CSP can allowlist. A REMOTE
// self-hosted ingress (e.g. an ngrok wss:// URL) still can't be — those
// connections need the planned proxy-through-main follow-up.
//
// https://storage.googleapis.com (+ wildcard) in connect-src: teleport streams
// assistant `.vbundle` bytes directly to/from GCS via platform-issued signed
// URLs (PUT on export-to-cloud, GET on import-to-local). Those requests leave
// the renderer for Google's storage host, which isn't a Vellum origin, so the
// transfer is CSP-blocked without an explicit allowlist. Both the path-style
// (`storage.googleapis.com/<bucket>/...`) and virtual-hosted
// (`<bucket>.storage.googleapis.com/...`) URL shapes are covered.
export const CSP_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://${WILDCARD_HOST}`,
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' blob: data: https://${WILDCARD_HOST} wss://${WILDCARD_HOST} https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.elevenlabs.io https://api.deepgram.com https://storage.googleapis.com https://*.storage.googleapis.com ws://localhost:* ws://127.0.0.1:*`,
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
