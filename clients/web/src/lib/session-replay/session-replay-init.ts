import { getPlatformRuntimeUrl } from "@/lib/local-mode";
import { sessionReplayNetworkConfig } from "@/lib/session-replay/network-sanitize";
import {
  installSessionReplayControlListeners,
  syncSessionReplay,
  type SessionReplayConfig,
} from "@/lib/session-replay/session-replay-control";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import { detectClientOs } from "@/runtime/platform-detection";

/**
 * Detect the host surface. Electron is checked first since its renderer also
 * runs the web bundle (mirrors `resolveDsn()` in `sentry-init.ts`).
 */
function sessionReplaySurface(): SessionReplayConfig["surface"] {
  if (isElectron() || isNativePlatform()) {
    return detectClientOs();
  }
  return "web";
}

/**
 * Origin that fronts `/_sr/cdn` and `/_sr/ingest`.
 *
 * Packaged Electron serves the renderer from `app://`. Replay must stay
 * same-origin so the protocol handler can forward `/_sr/*` to the platform.
 * A direct call to the platform URL is cross-origin from `app://` and the
 * `/_sr` proxy does not treat that as a same-origin page.
 *
 * Web, iOS, Android, and Electron-dev (http localhost) keep using the
 * platform runtime URL, which is the page origin on hosted surfaces.
 */
export function sessionReplayProxyBase(
  location: Pick<Location, "protocol" | "origin">,
  platformUrl: string,
): string {
  if (location.protocol === "app:") {
    return location.origin;
  }
  return platformUrl;
}

/**
 * Bootstrap session-replay consent gating. No-ops when
 * `VITE_SESSION_REPLAY_APP_ID` is unset (mirrors Sentry's no-DSN no-op), so the
 * plumbing stays dark until a real provider and the app ID are configured.
 */
export function initSessionReplay(): void {
  const appId = import.meta.env.VITE_SESSION_REPLAY_APP_ID;
  if (!appId) {
    return;
  }
  const config: SessionReplayConfig = {
    appId,
    surface: sessionReplaySurface(),
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local",
    release: import.meta.env.VITE_APP_VERSION,
    base: sessionReplayProxyBase(window.location, getPlatformRuntimeUrl()),
    network: sessionReplayNetworkConfig,
  };
  syncSessionReplay(config);
  installSessionReplayControlListeners(config);
}
