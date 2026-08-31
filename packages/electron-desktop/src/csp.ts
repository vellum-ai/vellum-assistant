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
// https://${WILDCARD_HOST} in script-src: packaged replay loads the recorder
// same-origin via the `app://` protocol handler (`/_sr/cdn/...`). Older
// renderers still fetch the script from the platform origin, so the wildcard
// stays. Ingest is covered by connect-src (`'self'` plus the wildcard) and
// the recorder worker by `worker-src ... blob:`.
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
//
// Stripe hosts: the billing payment-method modal (auto-top-up) loads Stripe.js
// via `loadStripe` (script-src js.stripe.com), which mounts the card and
// address inputs inside iframes on js.stripe.com / *.js.stripe.com (frame-src)
// and confirms SetupIntents against api.stripe.com (connect-src).
// hooks.stripe.com hosts the 3D Secure challenge frame. This is Stripe's
// documented CSP set for Stripe.js: https://docs.stripe.com/security/guide
// (minus maps.googleapis.com, which only applies when supplying your own
// Google Maps key to the Address Element).
// frame-src is the only directive that names Stripe hosts alongside 'self';
// without it frames fall back to `default-src 'self'`, which blocks the
// Element iframes. Keeping the list to 'self' + Stripe hosts costs the
// sandboxed srcdoc surfaces (visual, dynamic-page, app-viewer) nothing,
// because a srcdoc document resolves as 'self'.
//
// frame-src must not be dropped, and 'self' must stay the floor. It is the
// only control over where a sandboxed frame can navigate *itself*: no CSP
// directive constrains a document navigating its own browsing context from
// the inside (`navigate-to` was never shipped), so a frame rendering
// model-authored markup would otherwise be free to carry conversation data
// out in a URL. It is enforced on every navigation of a nested browsing
// context, not just the first load, which is what makes it work here.
// See ATL-1197.
export const CSP_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://${WILDCARD_HOST} https://js.stripe.com https://*.js.stripe.com`,
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' blob: data: https://${WILDCARD_HOST} wss://${WILDCARD_HOST} https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.elevenlabs.io https://api.deepgram.com https://storage.googleapis.com https://*.storage.googleapis.com https://api.stripe.com ws://localhost:* ws://127.0.0.1:*`,
  "frame-src 'self' https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
  "img-src 'self' https: data: blob:",
  // Hosted voice-preview samples: ElevenLabs premades live in the
  // eleven-public-prod GCS bucket (path-scoped so the rest of GCS stays
  // blocked for media), Deepgram Aura previews on static.deepgram.com.
  "media-src 'self' blob: https://storage.googleapis.com/eleven-public-prod/ https://static.deepgram.com/",
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
