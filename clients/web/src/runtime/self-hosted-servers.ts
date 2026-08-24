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
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
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
 * The one native origin-swap sequence: gate on the shell, run the pre-switch
 * preparation, hand `swap` to the bridge, and resolve whether the shell took
 * it. Every path out of an origin goes through here, so a preparation step
 * added later cannot land on one path and miss the other. `method` names the
 * bridge call for the skew debug line.
 *
 * Preparation drops the iOS widget snapshot. The target origin is a different
 * deployment with its own conversations, so the snapshot the running one
 * produced is about to describe an account the widgets are no longer showing,
 * and the producer id that catches a stale snapshot elsewhere cannot help
 * here: it lives in localStorage, which is per-origin and does not survive the
 * swap. The clear belongs here rather than at the call sites so that no way of
 * leaving an origin can forget it. The widgets sit empty until the new origin
 * resolves its own list, which beats the previous deployment's titles on a
 * Home Screen that never reloads on its own. A swap whose target is already
 * the current origin clears the snapshot too, which is accepted: the next
 * resolved list re-syncs it.
 *
 * The swap proceeds whether or not the clear lands, so nothing here reads its
 * outcome: a clear that fails persists its obligation and the next use of the
 * module finishes it, making the drop at-least-once rather than the
 * fire-and-forget it would be if the swap simply carried on. The one case the
 * marker cannot reach is the swap that succeeds, since it lives in the
 * per-origin localStorage this page is leaving, which is the same reason the
 * producer id cannot help here.
 *
 * That gap is closed on the other side of the bridge: the shell binds the App
 * Group snapshot to the origin it was produced on and drops it as soon as the
 * two disagree, in the same native call that rewrites the active slot, and
 * again at launch, which also covers an origin the iOS Settings pane rewrote
 * while the app was terminated. A swap that lands has therefore cleared,
 * whether or not this page got to. This clear stays as the primary anyway: it
 * is the only one an installed shell predating that guarantee performs, and on
 * a current shell it is a cheap best-effort that usually lands first. The
 * residual (a clear that fails and a swap that succeeds, leaving the old
 * snapshot) therefore exists only on those older shells, until they update.
 */
async function nativeOriginSwap(
  method: string,
  swap: () => Promise<unknown>,
): Promise<boolean> {
  if (!isNativeMobile()) {
    return false;
  }
  await clearWidgetSnapshot();
  try {
    await swap();
    return true;
  } catch (err) {
    console.debug(`[self-hosted-servers] ${method} unavailable:`, err);
    return false;
  }
}

/**
 * Swap the shell's origin in place, `null` meaning "back to the baked Vellum
 * Cloud origin". Resolves whether the shell took the switch, so a caller on an
 * older shell (or off native mobile) can fall back to a plain navigation.
 *
 * Runs through {@link nativeOriginSwap}, which drops the widget snapshot
 * before the shell leaves the origin.
 */
export async function nativeSwitchToOrigin(
  url: string | null,
): Promise<boolean> {
  return nativeOriginSwap("switchTo", () =>
    SelfHostedServers.switchTo(url === null ? {} : { url }),
  );
}

/**
 * Switch the shell to an origin and load a route atomically. A separate bridge
 * method preserves the skew fallback when an older shell lacks path support.
 *
 * Shares {@link nativeOriginSwap} with {@link nativeSwitchToOrigin}, so the
 * pre-switch snapshot clear covers this path too.
 */
export async function nativeSwitchToOriginPath(
  url: string | null,
  path: string,
): Promise<boolean> {
  return nativeOriginSwap("switchToPath", () =>
    SelfHostedServers.switchToPath({
      ...(url === null ? {} : { url }),
      path,
    }),
  );
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
