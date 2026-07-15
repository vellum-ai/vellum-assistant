/**
 * Reads the "install this plugin after onboarding" intent written by the
 * marketing plugin page's "Install in your assistant" button when the user was
 * logged in but had no assistant yet (state B).
 *
 * The marketing side (platform repo `web/src/lib/plugins-pending-intent.ts`)
 * persists `{ pluginId, ts }` under `PENDING_PLUGIN_INSTALL_KEY` in
 * `localStorage` — a URL param wouldn't survive onboarding (which lands on
 * `/assistant?onboarding=1`). Onboarding folds the plugin into the set it
 * installs (see `research-runner`), so the user arrives with it already set up.
 *
 * Both sides MUST agree on the key + shape. Same-origin only (dev-only surface
 * served from the assistant host, sharing `localStorage` with marketing).
 */

import { getLocalSetting, removeLocalSetting } from "@/utils/local-settings";

export const PENDING_PLUGIN_INSTALL_KEY = "vellum_pending_plugin_install";

/** Ignore intents older than this so a stale one can't fire much later. */
export const PENDING_PLUGIN_INSTALL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

interface PendingPluginInstall {
  pluginId: string;
  ts: number;
}

/**
 * The pending plugin id, or `null` when there is none / it is malformed /
 * expired. Reading does not clear it — call {@link clearPendingPluginInstall}
 * once consumed.
 */
export function readPendingPluginInstall(): string | null {
  const raw = getLocalSetting(PENDING_PLUGIN_INSTALL_KEY, "");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPluginInstall>;
    if (typeof parsed?.pluginId !== "string" || !parsed.pluginId) {
      return null;
    }
    if (typeof parsed.ts !== "number") {
      return null;
    }
    if (Date.now() - parsed.ts > PENDING_PLUGIN_INSTALL_MAX_AGE_MS) {
      return null;
    }
    return parsed.pluginId;
  } catch {
    return null;
  }
}

export function clearPendingPluginInstall(): void {
  removeLocalSetting(PENDING_PLUGIN_INSTALL_KEY);
}
