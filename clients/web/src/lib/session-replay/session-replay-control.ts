/**
 * Consent-gated lifecycle for session replay, mirroring `sentry-control.ts`.
 *
 * Replay records the web DOM, so a single web-layer client covers every surface
 * (browser, Electron renderer, iOS WKWebview) — there is no native uploader or
 * per-host client to fan out to. SDK access dispatches through the provider seam
 * (`session-replay-provider.ts`), a no-op today.
 *
 * Fail-closed: the provider is never started until consent is confirmed. On a
 * mid-session revoke the provider is stopped best-effort; a hard reset takes
 * effect on the next reload (see the provider's `stop` contract).
 */
import { diagnosticsConsentGranted } from "@/lib/sentry/consent-gate";
import type { SessionReplayNetworkConfig } from "@/lib/session-replay/network-sanitize";
import {
  provider,
  type SessionReplaySurface,
  type SessionReplayTraits,
} from "@/lib/session-replay/session-replay-provider";
import { useAuthStore } from "@/stores/auth-store";
import { watchDeviceSetting } from "@/utils/device-settings";

export interface SessionReplayConfig {
  appId: string;
  surface: SessionReplaySurface;
  environment: string;
  release?: string;
  /** Origin fronting the first-party session replay proxy. */
  base: string;
  network: SessionReplayNetworkConfig;
}

/**
 * Session replay is gated on the SAME composed consent as Sentry diagnostics
 * (confirmed-live platform session AND the effective reporting gate). This thin
 * wrapper is the seam: if replay later needs its own consent, only this changes.
 */
export function sessionReplayConsentGranted(): boolean {
  return diagnosticsConsentGranted();
}

function buildTraits(surface: SessionReplaySurface): SessionReplayTraits {
  const { user } = useAuthStore.getState();
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return {
    name: name || undefined,
    email: user?.email ?? undefined,
    username: user?.username ?? undefined,
    surface,
  };
}

/**
 * Identify the active recording with the authenticated user. No-op when no
 * recording is active or no user is resolved (`user.id` already falls back to
 * email/username in the auth store).
 */
export function identifySessionReplayUser(surface: SessionReplaySurface): void {
  if (!provider.isActive()) return;
  const uid = useAuthStore.getState().user?.id;
  if (!uid) return;
  provider.identify(uid, buildTraits(surface));
}

function tryInit(config: SessionReplayConfig): void {
  if (provider.isActive()) return;
  provider.init(config.appId, {
    environment: config.environment,
    release: config.release,
    surface: config.surface,
    base: config.base,
    // Live gate the SDK re-checks before every upload — a mid-session revoke
    // stops ingestion even though the recorder can't be un-init'd.
    shouldSendData: sessionReplayConsentGranted,
    network: config.network,
  });
  identifySessionReplayUser(config.surface);
}

function tryStop(): void {
  if (!provider.isActive()) return;
  provider.stop();
}

/**
 * Apply the current consent to the replay provider — start when granted and not
 * running, stop (best-effort) when not. Idempotent when consent matches state.
 */
export function syncSessionReplay(config: SessionReplayConfig): void {
  if (sessionReplayConsentGranted()) {
    tryInit(config);
  } else {
    tryStop();
  }
}

/**
 * Install listeners so the replay client re-applies the gate whenever an input
 * changes — the effective reporting gate (`device:diagnostics_reporting`) or a
 * platform-session transition — and re-identifies when the authenticated user
 * changes. Reuses the same signals Sentry watches, so platform-side revokes
 * picked up by `consent-refresh.ts` flow through here with no extra wiring.
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installSessionReplayControlListeners(
  config: SessionReplayConfig,
): () => void {
  const stopDeviceWatch = watchDeviceSetting("diagnosticsReporting", () =>
    syncSessionReplay(config),
  );
  const stopSessionWatch = useAuthStore.subscribe((state, prevState) => {
    if (
      state.platformSession !== prevState.platformSession ||
      state.platformSessionRestoredOffline !==
        prevState.platformSessionRestoredOffline
    ) {
      syncSessionReplay(config);
    } else if (state.user?.id !== prevState.user?.id) {
      identifySessionReplayUser(config.surface);
    }
  });
  return () => {
    stopDeviceWatch();
    stopSessionWatch();
  };
}
