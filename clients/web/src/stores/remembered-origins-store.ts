/**
 * Remembered-origins store: the client-local list of remote assistant
 * origins the chooser can offer alongside platform-API assistants and the
 * same-machine lockfile.
 *
 * Each entry is `{ name?, url, addedAt }` and nothing else. The `url` is the
 * assistant's public base (origin plus optional path prefix, e.g.
 * `https://host/assistant-123`) and never carries credentials: the
 * credential for an origin is its origin-scoped HttpOnly refresh cookie,
 * which never passes through this store.
 *
 * Persistence is pluggable via {@link RememberedOriginsProvider}. The
 * default {@link localStorageProvider} stores per-origin browser state,
 * which is what makes the cloud origin act as the browser's hub; native
 * shells swap in their own provider via
 * {@link setRememberedOriginsProvider}.
 *
 * Leaf module: must not import from chooser/screen modules.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { watchSetting } from "@/utils/local-settings";
import { createStorageAccessor } from "@/utils/typed-storage";

export interface RememberedOrigin {
  name?: string;
  /** Normalized public base URL: origin plus optional path prefix. */
  url: string;
  /** ISO-8601 timestamp of when the origin was first remembered. */
  addedAt: string;
}

export const REMEMBERED_ORIGINS_STORAGE_KEY = "vellum:remembered-origins";

/**
 * Normalize a candidate origin URL to its canonical stored form, or `null`
 * when it is not a usable `https:` base. Mirrors the iOS shell: the
 * validation stance of `SelfHostedServer.validate` and the canonical form
 * of `SelfHostedServer.canonicalize`, so both stores agree on which
 * strings mean the same server.
 *
 * Canonical form: lowercase scheme and host (via `URL.origin`, which also
 * drops any userinfo), path prefix preserved with trailing slashes
 * stripped, query and hash dropped.
 */
export function normalizeOriginUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") {
    return null;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

// ---------------------------------------------------------------------------
// Persistence providers
// ---------------------------------------------------------------------------

export interface RememberedOriginsProvider {
  load: () => Promise<RememberedOrigin[]>;
  save: (entries: RememberedOrigin[]) => Promise<void>;
  /**
   * Optional: report changes to the persisted value made outside this
   * handle (another tab, the native shell) so hydrated store state can
   * refresh. Returns an unsubscribe function.
   */
  watch?: (onChange: () => void) => () => void;
}

/**
 * Defensive read of untrusted entry items (persisted JSON, a native bridge
 * payload): non-object items and urls failing {@link normalizeOriginUrl} are
 * dropped, and the first entry for a url wins. Every provider funnels its raw
 * items through here so the backends agree on entry identity.
 *
 * @param fallbackAddedAt Stamped on items carrying no `addedAt`. Defaults to
 *   now; a provider whose backend cannot record the timestamp passes a
 *   constant so the value is stable across loads.
 */
export function toRememberedOrigins(
  items: unknown[],
  fallbackAddedAt?: string,
): RememberedOrigin[] {
  const entries: RememberedOrigin[] = [];
  const seen = new Set<string>();
  const fallback = fallbackAddedAt ?? new Date().toISOString();
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { url, name, addedAt } = item as Record<string, unknown>;
    if (typeof url !== "string") {
      continue;
    }
    const normalized = normalizeOriginUrl(url);
    if (normalized === null || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push({
      url: normalized,
      ...(typeof name === "string" && name !== "" ? { name } : {}),
      addedAt: typeof addedAt === "string" ? addedAt : fallback,
    });
  }
  return entries;
}

/** Anything that isn't a JSON array reads as unusable, not as empty. */
function parseStoredEntries(raw: string): RememberedOrigin[] | null {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? toRememberedOrigins(parsed) : null;
}

// Device-scoped: the remembered list is this device's client-local view of
// its assistants (like the same-machine lockfile), so it survives hub logout.
const storage = createStorageAccessor<RememberedOrigin[]>({
  key: REMEMBERED_ORIGINS_STORAGE_KEY,
  scope: "device",
  parse: parseStoredEntries,
  serialize: JSON.stringify,
  fallback: [],
});

export const localStorageProvider: RememberedOriginsProvider = {
  load: async () => storage.load(),
  save: async (entries) => {
    storage.save(entries);
  },
  watch: (onChange) => watchSetting(REMEMBERED_ORIGINS_STORAGE_KEY, onChange),
};

let activeProvider: RememberedOriginsProvider = localStorageProvider;
let hydrationPromise: Promise<void> | null = null;
/** Bumped on provider swap so an in-flight stale load can't clobber state. */
let hydrationEpoch = 0;

/**
 * Mutations run one at a time through this chain so a slow async save can
 * never land after a later mutation's save and roll persisted state back.
 * The chain serializes this tab only; {@link withCrossTabLock} extends the
 * guarantee across tabs sharing the localStorage-backed provider.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

const MUTATION_LOCK_NAME = "vellum:remembered-origins:mutate";

/**
 * Make the read-modify-write mutation atomic across tabs via the Web Locks
 * API. Without it (non-browser test envs, very old engines) the in-tab
 * queue still applies and concurrent-tab writes fall back to last-writer.
 */
async function withCrossTabLock<T>(mutation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) {
    return mutation();
  }
  // `LockManager.request` infers its type parameter from the callback's
  // return, so the call is typed `Promise<Promise<T>>`; awaiting collapses it.
  return await locks.request(MUTATION_LOCK_NAME, mutation);
}

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const locked = () => withCrossTabLock(mutation);
  const run = mutationQueue.then(locked, locked);
  mutationQueue = run.catch(() => undefined);
  return run;
}

let unwatchProvider: (() => void) | null = null;

/**
 * Re-load the provider's current value into already-hydrated state, e.g.
 * after another tab or the native shell changed the persisted list. Runs
 * through the mutation queue so a slow refresh load can never publish
 * state that a later mutation's save has already superseded.
 */
/**
 * Set when a watch event arrives while the initial hydration load is still
 * pending: the refresh cannot publish yet (the store is unhydrated), so
 * hydration completion triggers a follow-up refresh instead of leaving the
 * store on its possibly older snapshot.
 */
let refreshSkippedWhileUnhydrated = false;

function refreshFromProvider(epoch: number): Promise<void> {
  return enqueueMutation(async () => {
    try {
      const origins = await activeProvider.load();
      if (epoch !== hydrationEpoch) {
        return;
      }
      if (useRememberedOriginsStoreBase.getState().hydrated) {
        useRememberedOriginsStoreBase.setState({ origins });
      } else if (hydrationPromise === null) {
        // A failed hydration already settled, so nothing would consume the
        // skip flag; this event signals the provider recovered, so retry
        // hydration now (its load is at least as fresh as this one).
        void useRememberedOriginsStoreBase.getState().hydrate();
      } else {
        refreshSkippedWhileUnhydrated = true;
      }
    } catch {
      // Keep current state; the next mutation or hydrate retries.
    }
  });
}

function watchActiveProvider(): void {
  unwatchProvider?.();
  const epoch = hydrationEpoch;
  unwatchProvider =
    activeProvider.watch?.(() => void refreshFromProvider(epoch)) ?? null;
}

/**
 * Swap the persistence provider (e.g. for a native Capacitor-backed store)
 * and re-hydrate from it.
 */
export function setRememberedOriginsProvider(
  provider: RememberedOriginsProvider,
): void {
  activeProvider = provider;
  hydrationEpoch += 1;
  hydrationPromise = null;
  refreshSkippedWhileUnhydrated = false;
  useRememberedOriginsStoreBase.setState({ hydrated: false });
  watchActiveProvider();
  void useRememberedOriginsStoreBase.getState().hydrate();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RememberedOriginsState {
  origins: RememberedOrigin[];
  hydrated: boolean;
}

export type AddOriginResult =
  | { ok: true; origin: RememberedOrigin }
  | { ok: false };

export interface RememberedOriginsActions {
  /**
   * Load from the provider; concurrent calls share one promise. A failed
   * load leaves the store unhydrated and a later call retries.
   */
  hydrate: () => Promise<void>;
  /**
   * Remember an origin. Invalid urls return `{ ok: false }`, as does a
   * mutation attempted while the provider cannot be read (so a failed load
   * can never be overwritten with a list built from empty state). Re-adding
   * an already-remembered url keeps its original `addedAt` and updates
   * `name` only when a new one is provided.
   */
  addOrigin: (input: { url: string; name?: string }) => Promise<AddOriginResult>;
  removeOrigin: (url: string) => Promise<void>;
}

export type RememberedOriginsStore = RememberedOriginsState &
  RememberedOriginsActions;

const useRememberedOriginsStoreBase = create<RememberedOriginsStore>()(
  (set, get) => ({
    origins: [],
    hydrated: false,

    hydrate: () => {
      hydrationPromise ??= (async () => {
        const epoch = hydrationEpoch;
        // Yield before calling the provider so a synchronous load() throw is
        // caught only after the ??= above has installed this promise;
        // otherwise the catch's reset would be overwritten and later
        // hydrate() calls could never retry.
        await Promise.resolve();
        try {
          const origins = await activeProvider.load();
          if (epoch === hydrationEpoch) {
            set({ origins, hydrated: true });
            if (refreshSkippedWhileUnhydrated) {
              // A watch event fired mid-hydration; our snapshot may already
              // be stale, so reconcile with the provider's latest.
              refreshSkippedWhileUnhydrated = false;
              void refreshFromProvider(epoch);
            }
          }
        } catch {
          // Stay unhydrated so a later hydrate() retries; never persist a
          // list built from state the provider was not able to load.
          if (epoch === hydrationEpoch) {
            hydrationPromise = null;
          }
        }
      })();
      return hydrationPromise;
    },

    addOrigin: async ({ url, name }) => {
      const normalized = normalizeOriginUrl(url);
      if (normalized === null) {
        return { ok: false };
      }
      return enqueueMutation(async (): Promise<AddOriginResult> => {
        await get().hydrate();
        if (!get().hydrated) {
          return { ok: false };
        }
        // Pin the provider and epoch for the whole mutation: a provider swap
        // while we await its load must abort rather than save a list derived
        // from the old provider into the new one.
        const provider = activeProvider;
        const epoch = hydrationEpoch;
        // Re-load so the working list includes entries another tab (or
        // provider client) persisted after this tab hydrated.
        let current: RememberedOrigin[];
        try {
          current = await provider.load();
        } catch {
          return { ok: false };
        }
        if (epoch !== hydrationEpoch) {
          return { ok: false };
        }
        const trimmedName = name?.trim();
        const existing = current.find((o) => o.url === normalized);
        const base: RememberedOrigin = existing ?? {
          url: normalized,
          addedAt: new Date().toISOString(),
        };
        const origin = trimmedName ? { ...base, name: trimmedName } : base;
        const origins = existing
          ? current.map((o) => (o.url === normalized ? origin : o))
          : [...current, origin];
        // Publish state only after persistence succeeds so the chooser never
        // shows an entry the provider does not actually hold.
        try {
          await provider.save(origins);
        } catch {
          return { ok: false };
        }
        // A provider swap during the save supersedes this mutation: the
        // active provider does not hold the origin, so report failure.
        if (epoch !== hydrationEpoch) {
          return { ok: false };
        }
        set({ origins });
        return { ok: true, origin };
      });
    },

    removeOrigin: async (url) => {
      const normalized = normalizeOriginUrl(url);
      if (normalized === null) {
        return;
      }
      await enqueueMutation(async () => {
        await get().hydrate();
        if (!get().hydrated) {
          return;
        }
        const provider = activeProvider;
        const epoch = hydrationEpoch;
        let current: RememberedOrigin[];
        try {
          current = await provider.load();
        } catch {
          return;
        }
        if (epoch !== hydrationEpoch) {
          return;
        }
        const remaining = current.filter((o) => o.url !== normalized);
        if (remaining.length !== current.length) {
          try {
            await provider.save(remaining);
          } catch {
            return;
          }
        }
        if (epoch === hydrationEpoch) {
          set({ origins: remaining });
        }
      });
    },
  }),
);

// Watch the default provider from the start so a hydrated tab picks up
// changes other tabs persist.
watchActiveProvider();

export const useRememberedOriginsStore = createSelectors(
  useRememberedOriginsStoreBase,
);
