import {
  installSessionReplayControlListeners,
  syncSessionReplay,
  type SessionReplayConfig,
} from "@/lib/session-replay/session-replay-control";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

/**
 * Detect the host surface. Electron is checked first since its renderer also
 * runs the web bundle (mirrors `resolveDsn()` in `sentry-init.ts`).
 */
function sessionReplaySurface(): SessionReplayConfig["surface"] {
  if (isElectron()) return "electron";
  if (isNativePlatform()) return "ios";
  return "web";
}

/**
 * Bootstrap session-replay consent gating. Must run after
 * `migrateDeviceSettings()` so the device gate is readable. No-ops when
 * `VITE_SESSION_REPLAY_APP_ID` is unset (mirrors Sentry's no-DSN no-op), so the
 * plumbing stays dark until a real provider and the app ID are configured.
 */
export function initSessionReplay(): void {
  const appId = import.meta.env.VITE_SESSION_REPLAY_APP_ID;
  if (!appId) return;
  const config: SessionReplayConfig = {
    appId,
    surface: sessionReplaySurface(),
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local",
    release: import.meta.env.VITE_APP_VERSION,
  };
  syncSessionReplay(config);
  installSessionReplayControlListeners(config);
}
