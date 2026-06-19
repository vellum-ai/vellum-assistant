/**
 * Provider seam for session replay. The consent/lifecycle logic in
 * `session-replay-control.ts` dispatches through this single interface so the
 * real replay SDK can be dropped in later by swapping `provider` — no caller
 * changes. The active provider is a no-op today: the plumbing (consent gate,
 * identify, lifecycle) is wired and tested, but nothing records until a real
 * provider replaces `noopProvider`.
 */

export type SessionReplaySurface = "web" | "macos" | "ios";

export interface SessionReplayInitOptions {
  environment: string;
  release?: string;
  surface: SessionReplaySurface;
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
 * No-op provider: owns lifecycle state so the control layer stays stateless
 * (mirroring the Sentry flavor's `getClientEnabled()`), and logs in dev so the
 * consent gate is observable without an SDK. Swap this one binding to go live.
 */
const noopProvider: SessionReplayProvider = (() => {
  let active = false;
  return {
    init(appId, options) {
      active = true;
      if (import.meta.env.DEV) {
        console.debug("[session-replay] init", {
          appId,
          surface: options.surface,
        });
      }
    },
    identify(uid, traits) {
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

export const provider: SessionReplayProvider = noopProvider;
