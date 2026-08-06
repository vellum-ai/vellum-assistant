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
 * when it is not a usable `https:` base (mirrors the validation stance of
 * `SelfHostedServer.validate` in the iOS shell).
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
}

/**
 * Defensive parse of persisted JSON: anything that isn't an array becomes
 * empty, and entries whose `url` fails {@link normalizeOriginUrl} (or that
 * duplicate an earlier entry's url) are dropped.
 */
function parseStoredEntries(raw: string): RememberedOrigin[] | null {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const entries: RememberedOrigin[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
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
      addedAt:
        typeof addedAt === "string" ? addedAt : new Date().toISOString(),
    });
  }
  return entries;
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
};

let activeProvider: RememberedOriginsProvider = localStorageProvider;
let hydrationPromise: Promise<void> | null = null;
/** Bumped on provider swap so an in-flight stale load can't clobber state. */
let hydrationEpoch = 0;

/**
 * Mutations run one at a time through this chain so a slow async save can
 * never land after a later mutation's save and roll persisted state back.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(mutation, mutation);
  mutationQueue = run.catch(() => undefined);
  return run;
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
  useRememberedOriginsStoreBase.setState({ hydrated: false });
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
        try {
          const origins = await activeProvider.load();
          if (epoch === hydrationEpoch) {
            set({ origins, hydrated: true });
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
        // Re-load so the working list includes entries another tab (or
        // provider client) persisted after this tab hydrated.
        let current: RememberedOrigin[];
        try {
          current = await activeProvider.load();
        } catch {
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
        set({ origins });
        await activeProvider.save(origins);
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
        let current: RememberedOrigin[];
        try {
          current = await activeProvider.load();
        } catch {
          return;
        }
        const remaining = current.filter((o) => o.url !== normalized);
        set({ origins: remaining });
        if (remaining.length !== current.length) {
          await activeProvider.save(remaining);
        }
      });
    },
  }),
);

export const useRememberedOriginsStore = createSelectors(
  useRememberedOriginsStoreBase,
);
