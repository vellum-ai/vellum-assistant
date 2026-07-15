/**
 * Plugins the user should start with based on where they came from.
 *
 * When a logged-in user with no assistant yet clicks "Install in your assistant"
 * on a marketing plugin page (state B), the marketing side (platform repo
 * `web/src/lib/plugins-pending-intent.ts`) stashes the plugin in `localStorage`
 * — a URL param wouldn't survive onboarding, which lands on
 * `/assistant?onboarding=1`. Onboarding folds this into the set it installs (see
 * `onboarding-plugin-affinity`), so the user arrives with it already set up.
 *
 * It's a signal, not a one-shot command: it isn't consumed/cleared. Installs are
 * idempotent, so a re-read is harmless, and the record expires after
 * {@link PENDING_PLUGIN_INSTALL_MAX_AGE_MS} so a stale one can't linger. Not
 * clearing also means a momentarily-empty catalog (nothing installed this run)
 * doesn't discard the intent — a later run within the TTL still honors it.
 *
 * Both sides MUST agree on the key + shape. Same-origin only (dev-only surface
 * served from the assistant host, sharing `localStorage` with marketing).
 */

import { getLocalSetting } from "@/utils/local-settings";

export const PENDING_PLUGIN_INSTALL_KEY = "vellum_pending_plugin_install";

/** Ignore intents older than this so a stale one can't fire much later. */
export const PENDING_PLUGIN_INSTALL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

interface PendingPluginInstall {
  pluginId: string;
  ts: number;
}

/**
 * The attributed plugin id, or `null` when there is none / it is malformed /
 * expired.
 */
function readAttributedPluginId(): string | null {
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

/**
 * Plugin names to install for the user based on marketing attribution — the
 * plugin they clicked "Install" on before onboarding. Empty when there's none.
 */
export function pluginsFromAttribution(): string[] {
  const pluginId = readAttributedPluginId();
  return pluginId ? [pluginId] : [];
}
