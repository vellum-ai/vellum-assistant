/**
 * Provider seam for session replay. The consent/lifecycle logic in
 * `session-replay-control.ts` dispatches through this single interface so the
 * active SDK can be swapped by changing the `provider` binding — no caller
 * changes.
 */
// Session-replay vendor SDK. Referenced only through the neutral `replaySdk`
// alias below so the vendor name stays out of shipped code and proxied URLs
// (it's pattern-matched by ad-blockers — the whole reason we proxy first-party).
import replaySdk from "logrocket";

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
 * mid-page, so `stop` is best-effort — a hard reset only takes effect on the
 * next reload (per the `stop` contract above).
 */
const replayProvider: SessionReplayProvider = (() => {
  let active = false;
  return {
    init(appId, options) {
      // Must be set before init so the SDK loads the recorder from our proxy.
      window._lrAsyncScript = `${options.base}/_sr/cdn/logger.min.js`;
      replaySdk.init(appId, {
        serverURL: `${options.base}/_sr/ingest/i`,
        release: options.release,
        // Share the recording session across Vellum subdomains.
        rootHostname: import.meta.env.VITE_ROOT_HOSTNAME ?? ".vellum.ai",
      });
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
      replaySdk.identify(uid, userTraits);
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
