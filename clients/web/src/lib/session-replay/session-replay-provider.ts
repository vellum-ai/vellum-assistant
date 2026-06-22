/**
 * Provider seam for session replay. The consent/lifecycle logic in
 * `session-replay-control.ts` dispatches through this single interface so the
 * active SDK can be swapped by changing the `provider` binding — no caller
 * changes.
 */
import type { SessionReplayNetworkConfig } from "@/lib/session-replay/network-sanitize";

// Type-only handle to the vendor SDK. The runtime module is loaded lazily (see
// `init`) — never statically imported, because the SDK eagerly appends its
// recorder <script> at module-evaluation time, which would fetch the recorder
// from the vendor's default CDN at app startup (before consent and bypassing
// our first-party proxy). The `logrocket` name is otherwise kept out of shipped
// code so ad-blockers can't pattern-match it.
type ReplaySdk = typeof import("logrocket");

/** The SDK's `network` option type, derived from the SDK's own init signature. */
type SdkNetworkOption = NonNullable<
  Parameters<ReplaySdk["init"]>[1]
>["network"];

export type SessionReplaySurface = "web" | "macos" | "ios";

export interface SessionReplayInitOptions {
  environment: string;
  release?: string;
  surface: SessionReplaySurface;
  /**
   * Origin fronting the first-party replay proxy (resolved per environment +
   * surface in `session-replay-init.ts`). The recorder script and ingest
   * endpoint are served from here via the platform's reverse-proxy rewrites.
   */
  base: string;
  /**
   * Live consent gate the SDK calls before every upload. The recorder can't be
   * un-init'd mid-page, so this — not `stop()` — is what halts ingestion the
   * instant consent is revoked. Returns the current composed consent.
   */
  shouldSendData: () => boolean;
  /** Request/response sanitizers forwarded to the SDK's `network` config. */
  network: SessionReplayNetworkConfig;
}

/** Metadata about the authenticated platform user attached to a recording. */
export interface SessionReplayTraits {
  name?: string;
  email?: string;
  username?: string;
  surface: SessionReplaySurface;
}

export interface SessionReplayProvider {
  /** Start the SDK. Called once, only after consent is confirmed. */
  init(appId: string, options: SessionReplayInitOptions): void;
  /** Associate the active recording with the authenticated platform user. */
  identify(uid: string, traits: SessionReplayTraits): void;
  /**
   * Best-effort stop. Replay SDKs cannot fully un-init mid-page, so a real
   * provider may keep the page network-silent but only fully reset on reload.
   */
  stop(): void;
  /** Whether a recording is currently active (started and not stopped). */
  isActive(): boolean;
}

/**
 * Active provider. All traffic is first-party: the recorder script
 * (`window._lrAsyncScript`) and the ingest endpoint (`serverURL`) are served
 * from our own origin via the platform's reverse-proxy rewrites
 * (`/_sr/cdn/*` and `/_sr/ingest/*`), so ad-blockers and tracking-protection
 * don't silently break recordings.
 *
 * Owns lifecycle state so the control layer stays stateless (mirroring the
 * Sentry flavor's `getClientEnabled()`). The SDK cannot be fully un-init'd
 * mid-page, so ingestion is gated live on consent via `shouldSendData` — `stop`
 * stays best-effort (it flips `active`, halting re-identify) and a hard reset
 * of the in-memory recorder only takes effect on the next reload.
 */
const replayProvider: SessionReplayProvider = (() => {
  let active = false;
  // The SDK is loaded once; re-running its `init` can't cleanly re-init the
  // recorder, so a revoke→re-grant within a page must not load/init it again.
  let started = false;
  // Resolved SDK once the lazy import completes; until then `identify` calls
  // queue in `pendingIdentify` (latest wins) and flush on load.
  let sdk: ReplaySdk | null = null;
  let pendingIdentify: { uid: string; traits: Record<string, string> } | null =
    null;

  return {
    init(appId, options) {
      if (!started) {
        started = true;
        // Set before the SDK module evaluates: its eager loader appends the
        // recorder <script> reading `window._lrAsyncScript`, so this points it
        // at our first-party proxy instead of the vendor CDN.
        window._lrAsyncScript = `${options.base}/_sr/cdn/logger.min.js`;
        // Lazy import so the eager recorder load happens only here (consent
        // confirmed), never at app startup. See the `ReplaySdk` type note.
        void import("logrocket").then((mod) => {
          // `logrocket` is CJS (`export = `); the interop default holds the SDK.
          const replaySdk = (mod as { default: ReplaySdk }).default;
          // The SDK splits traffic into a data endpoint (`serverURL`, set via
          // init below) and a separate stats beacon — which has no init option
          // and otherwise POSTs to the vendor host directly, bypassing the proxy
          // (a CSP violation under Electron's `app://` and an ad-blocker target).
          // Its config object is the only lever, so point the beacon at the proxy
          // here, after the module's loader has populated the object but before
          // the async recorder bundle reads it.
          window.__SDKCONFIG__ = window.__SDKCONFIG__ ?? {};
          window.__SDKCONFIG__.statsURL = `${options.base}/_sr/ingest/s`;
          replaySdk.init(appId, {
            serverURL: `${options.base}/_sr/ingest/i`,
            release: options.release,
            // Share the recording session across Vellum subdomains.
            rootHostname: import.meta.env.VITE_ROOT_HOSTNAME ?? ".vellum.ai",
            // Live consent gate: evaluated before every upload, so a mid-session
            // opt-out halts ingestion immediately rather than at next reload.
            shouldSendData: options.shouldSendData,
            // SessionReplayNetworkConfig mirrors the SDK's `network` option; the
            // sanitizers spread-preserve SDK-private fields (e.g. reqId), so this
            // structural cast across the seam is safe.
            network: options.network as SdkNetworkOption,
            dom: {
              // Surfaces a console warning when a stylesheet can't be recorded —
              // the cause of unstyled replays. The recorder captures console
              // output, so the diagnostic lands in the session itself. Non-prod
              // only, to keep production consoles quiet.
              shouldLogDroppedStyleDiagnostics:
                options.environment !== "production",
            },
          });
          sdk = replaySdk;
          if (pendingIdentify) {
            replaySdk.identify(pendingIdentify.uid, pendingIdentify.traits);
            pendingIdentify = null;
          }
        });
      }
      active = true;
      if (import.meta.env.DEV) {
        console.debug("[session-replay] init", {
          appId,
          surface: options.surface,
        });
      }
    },
    identify(uid, traits) {
      // Traits disallow undefined values, so attach only what's present.
      const userTraits: Record<string, string> = { surface: traits.surface };
      if (traits.name) userTraits.name = traits.name;
      if (traits.email) userTraits.email = traits.email;
      if (traits.username) userTraits.username = traits.username;
      // Queue until the lazy SDK import resolves, then dispatch directly.
      if (sdk) sdk.identify(uid, userTraits);
      else pendingIdentify = { uid, traits: userTraits };
      if (import.meta.env.DEV) {
        console.debug("[session-replay] identify", {
          uid,
          surface: traits.surface,
        });
      }
    },
    stop() {
      active = false;
      if (import.meta.env.DEV) console.debug("[session-replay] stop");
    },
    isActive: () => active,
  };
})();

export const provider: SessionReplayProvider = replayProvider;
