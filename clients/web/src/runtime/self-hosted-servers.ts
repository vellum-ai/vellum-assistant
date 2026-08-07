/**
 * JS side of the `SelfHostedServers` Capacitor plugin
 * (`clients/ios/App/App/SelfHostedServersPlugin.swift`), which owns the
 * remembered assistant origins on a native mobile shell.
 *
 * On a shell that has the plugin, the native list is the source of truth: it
 * survives a web-storage clear, it is the same list the native Settings pane
 * and the `<scheme>://connect` deep link write, and only the shell can point
 * its `WKWebView` at another origin without leaving the app. So the chooser
 * installs {@link nativeRememberedOriginsProvider} over the store's default
 * localStorage provider, and `switchToOrigin` routes through
 * {@link nativeSwitchToOrigin}.
 *
 * **Skew contract** (`docs/CAPACITOR.md` § The skew rule): this bundle is live
 * for every user on their next app load while the installed shell only changes
 * after App Store review, so the plugin may always be absent. Every bridge call
 * is wrapped: a failure is an expected older shell, so it logs `console.debug`
 * (never `captureError`) and degrades to the behavior that shell already had,
 * which is the localStorage provider for storage and a plain navigation for
 * switching. There is no availability probe: a probe can itself be absent, and
 * the failure of the call the caller wanted to make is the same answer.
 */

import { registerPlugin } from "@capacitor/core";

import { isNativeMobile } from "@/runtime/platform-detection";
import {
  localStorageProvider,
  normalizeOriginUrl,
  setRememberedOriginsProvider,
  toRememberedOrigins,
  type RememberedOrigin,
  type RememberedOriginsProvider,
} from "@/stores/remembered-origins-store";

/** One remembered server as the plugin reports it. */
interface SelfHostedServerEntry {
  name?: string;
  url: string;
}

interface SelfHostedServersList {
  servers: SelfHostedServerEntry[];
  /** The configured self-hosted origin, or `null` when on the baked default. */
  activeUrl: string | null;
  /** The Vellum Cloud origin the shell ships with, or `null` if unreadable. */
  bakedUrl: string | null;
}

interface SelfHostedServersPlugin {
  list(): Promise<SelfHostedServersList>;
  add(options: { url: string; name?: string }): Promise<{ ok: boolean }>;
  remove(options: { url: string }): Promise<{ ok: boolean }>;
  /** An absent `url` returns the shell to its baked Vellum Cloud origin. */
  switchTo(options: { url?: string }): Promise<{ ok: boolean }>;
  /** Switches origin and loads a route relative to the assistant app entry. */
  switchToPath(options: {
    url?: string;
    path: string;
  }): Promise<{ ok: boolean }>;
}

/**
 * `registerPlugin` only builds the bridge Proxy, so this is inert until a
 * method is called: nothing reaches the shell before the flag-gated
 * {@link installNativeRememberedOrigins}.
 */
const SelfHostedServers =
  registerPlugin<SelfHostedServersPlugin>("SelfHostedServers");

/**
 * `addedAt` for natively-stored entries. The plugin records `{name?, url}` and
 * nothing else, so the timestamp is unknowable here; a stable constant keeps
 * the entry identity (its url) stable across loads, which is all the store and
 * the chooser read it for.
 */
const NATIVE_ADDED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Read the native list, or `null` when the bridge is unavailable. Only the
 * result crosses the `async` boundary, never the plugin Proxy itself, per
 * `docs/CAPACITOR.md` § "Capacitor plugins must be destructured inline".
 */
async function listNativeServers(): Promise<SelfHostedServersList | null> {
  try {
    return await SelfHostedServers.list();
  } catch (err) {
    console.debug("[self-hosted-servers] bridge unavailable:", err);
    return null;
  }
}

/**
 * Marker for the one-time localStorage-to-native migration. Shells that
 * predate the plugin remembered their origins in web storage, so the first
 * successful native load folds those entries in rather than letting the
 * native list silently drop them.
 */
const MIGRATION_MARKER_KEY = "vellum:remembered-origins:native-migrated";

function migrationDone(): boolean {
  try {
    return window.localStorage.getItem(MIGRATION_MARKER_KEY) === "true";
  } catch {
    // No web storage means nothing to migrate from.
    return true;
  }
}

function markMigrationDone(): void {
  try {
    window.localStorage.setItem(MIGRATION_MARKER_KEY, "true");
  } catch {
    // A failed marker write only costs a repeat merge, which is idempotent.
  }
}

/**
 * Fold pre-plugin localStorage entries into the native list once, returning
 * the merged view. Native entries win on name conflicts, since the shell and
 * its deep links are the newer writer. Only entries the shell accepted join
 * the result, so a partial merge never publishes a card the shell would
 * refuse to switch to; the marker stays unset so the next load retries.
 */
async function migrateLocalOriginsIntoNative(
  native: RememberedOrigin[],
): Promise<RememberedOrigin[]> {
  if (migrationDone()) {
    return native;
  }
  let local: RememberedOrigin[] = [];
  try {
    local = await localStorageProvider.load();
  } catch {
    local = [];
  }
  const knownUrls = new Set(native.map((o) => o.url));
  const missing = local.filter((o) => !knownUrls.has(o.url));
  const added: RememberedOrigin[] = [];
  for (const entry of missing) {
    try {
      await SelfHostedServers.add({
        url: entry.url,
        ...(entry.name ? { name: entry.name } : {}),
      });
    } catch (err) {
      console.debug("[self-hosted-servers] migration add failed:", err);
      return [...native, ...added];
    }
    added.push(entry);
  }
  markMigrationDone();
  return [...native, ...added];
}

/**
 * Store provider backed by the native list, falling back to the localStorage
 * provider whenever the bridge is unavailable.
 *
 * `save` receives the full desired list and diffs it against what the shell
 * currently holds, because the plugin exposes per-entry `add`/`remove` rather
 * than a whole-list write. A rejected `add`/`remove` propagates so the store
 * reports the mutation as failed instead of publishing an entry the shell does
 * not hold.
 */
export function nativeRememberedOriginsProvider(): RememberedOriginsProvider {
  return {
    load: async () => {
      const listed = await listNativeServers();
      if (listed === null) {
        return localStorageProvider.load();
      }
      const native = toRememberedOrigins(listed.servers, NATIVE_ADDED_AT);
      return migrateLocalOriginsIntoNative(native);
    },

    save: async (entries) => {
      const listed = await listNativeServers();
      if (listed === null) {
        await localStorageProvider.save(entries);
        return;
      }
      const current = new Map(
        toRememberedOrigins(listed.servers, NATIVE_ADDED_AT).map((o) => [
          o.url,
          o.name,
        ]),
      );
      const desired = new Set(entries.map((o) => o.url));
      // Serial, not concurrent: each native write is a read-modify-write of
      // one stored list, so overlapping calls would drop each other's edit.
      for (const url of current.keys()) {
        if (!desired.has(url)) {
          await SelfHostedServers.remove({ url });
        }
      }
      for (const entry of entries) {
        // A nameless re-add keeps the stored label natively, so only a new or
        // changed name is worth a write.
        if (
          !current.has(entry.url) ||
          (entry.name && entry.name !== current.get(entry.url))
        ) {
          await SelfHostedServers.add({
            url: entry.url,
            ...(entry.name ? { name: entry.name } : {}),
          });
        }
      }
    },

    // The native list changes only through this provider, so the forwarded
    // localStorage watch matters solely on the fallback path, where it keeps
    // the default provider's cross-tab behavior intact.
    watch: localStorageProvider.watch,
  };
}

let providerInstalled = false;

/**
 * Point the remembered-origins store at the native list on a mobile shell.
 * Idempotent, and a no-op everywhere else so web and Electron keep the
 * localStorage provider.
 */
export function installNativeRememberedOrigins(): void {
  if (providerInstalled || !isNativeMobile()) {
    return;
  }
  providerInstalled = true;
  setRememberedOriginsProvider(nativeRememberedOriginsProvider());
}

/**
 * Swap the shell's origin in place, `null` meaning "back to the baked Vellum
 * Cloud origin". Resolves whether the shell took the switch, so a caller on an
 * older shell (or off native mobile) can fall back to a plain navigation.
 */
export async function nativeSwitchToOrigin(
  url: string | null,
): Promise<boolean> {
  if (!isNativeMobile()) {
    return false;
  }
  try {
    await SelfHostedServers.switchTo(url === null ? {} : { url });
    return true;
  } catch (err) {
    console.debug("[self-hosted-servers] switchTo unavailable:", err);
    return false;
  }
}

/**
 * Switch the shell to an origin and load a route atomically. A separate bridge
 * method preserves the skew fallback when an older shell lacks path support.
 */
export async function nativeSwitchToOriginPath(
  url: string | null,
  path: string,
): Promise<boolean> {
  if (!isNativeMobile()) {
    return false;
  }
  try {
    await SelfHostedServers.switchToPath({
      ...(url === null ? {} : { url }),
      path,
    });
    return true;
  } catch (err) {
    console.debug("[self-hosted-servers] switchToPath unavailable:", err);
    return false;
  }
}

/**
 * The baked Vellum Cloud origin to offer as a way back, or `null` when there
 * is nothing to offer: off native mobile, on a shell without the plugin, or
 * when the shell is already serving the baked origin (no configured
 * self-hosted slot).
 */
export async function nativeVellumCloudOrigin(): Promise<string | null> {
  if (!isNativeMobile()) {
    return null;
  }
  const listed = await listNativeServers();
  if (listed === null || !listed.activeUrl) {
    return null;
  }
  return listed.bakedUrl ? normalizeOriginUrl(listed.bakedUrl) : null;
}
