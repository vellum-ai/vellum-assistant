/**
 * Typed localStorage factory utilities.
 *
 * Provides `createStorageAccessor` for static-key storage and
 * `createKeyedStorageAccessor` for per-entity keyed storage (e.g.,
 * per-assistant). Both return type-safe `load`/`save`/`remove` plus
 * a `useValue` React hook via `useSyncExternalStore`.
 *
 * Built on `local-settings.ts` for consistent SSR guards, error
 * swallowing, and same-tab change notifications.
 *
 * References:
 * - {@link https://react.dev/reference/react/useSyncExternalStore}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  removeLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cleanup scope determines behavior on logout. */
export type StorageScope = "user" | "device";

export interface StorageAccessorConfig<T> {
  /** The full localStorage key (must include prefix, e.g. `vellum:pinnedApps`). */
  key: string;
  /** `user` keys are cleared on logout; `device` keys are preserved. */
  scope: StorageScope;
  /** Deserialize the raw string into a typed value. Return `null` for invalid data. */
  parse: (raw: string) => T | null;
  /** Serialize the typed value to a string for storage. */
  serialize: (value: T) => string;
  /** Value returned when the key is absent, unreadable, or fails validation. */
  fallback: T;
}

export interface StorageAccessor<T> {
  /** Read the current value from localStorage. Returns `fallback` on any error. */
  load: () => T;
  /** Write a value to localStorage. Fires same-tab change notifications. */
  save: (value: T) => void;
  /** Remove the key from localStorage. Fires same-tab change notifications. */
  remove: () => void;
  /** The localStorage key (useful for cleanup/testing). */
  key: string;
  /** The declared scope. */
  scope: StorageScope;
  /**
   * React hook that subscribes to storage changes via `useSyncExternalStore`.
   * Concurrent-rendering-safe, no initial null→value flicker.
   */
  useValue: () => T;
}

/** Config for per-entity keyed storage. */
export interface KeyedStorageAccessorConfig<T> {
  /** Builds the localStorage key from an entity ID (e.g., assistantId). */
  keyFn: (id: string) => string;
  /** `user` keys are cleared on logout; `device` keys are preserved. */
  scope: StorageScope;
  /** Deserialize the raw string into a typed value. Return `null` for invalid data. */
  parse: (raw: string) => T | null;
  /** Serialize the typed value to a string for storage. */
  serialize: (value: T) => string;
  /** Value returned when the key is absent, unreadable, or fails validation. */
  fallback: T;
}

export interface KeyedStorageAccessor<T> {
  /** Read the current value for a given entity ID. Returns `fallback` on any error. */
  load: (id: string) => T;
  /** Write a value for a given entity ID. */
  save: (id: string, value: T) => void;
  /** Remove the key for a given entity ID. */
  remove: (id: string) => void;
  /** Build the localStorage key for a given entity ID. */
  keyFn: (id: string) => string;
  /** The declared scope. */
  scope: StorageScope;
  /**
   * React hook that subscribes to changes for one entity's key.
   * Concurrent-rendering-safe, and reads during render rather than in an
   * effect — so the first paint already carries the stored value instead of
   * the fallback.
   */
  useValue: (id: string) => T;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readRaw(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Per-entity snapshot cache for `useValue`, keyed by entity ID.
 *
 * `useSyncExternalStore` calls `getSnapshot` on every render and bails out
 * only when the result is reference-equal, so a non-primitive `T` reparsed
 * each call would re-render forever. Caching on the raw string keeps the
 * reference stable while the stored text is unchanged, and self-heals when
 * it isn't — the same contract `createStorageAccessor` implements for the
 * static case.
 *
 * Deliberately not shared with `load`. `load` returns a freshly parsed value
 * that callers may mutate; handing them the cached instance would corrupt
 * every subscriber's snapshot.
 */
function createSnapshotCache<T>(
  read: (id: string) => string | null,
  parseOrFallback: (raw: string | null) => T,
) {
  const cache = new Map<string, { raw: string | null; value: T }>();
  return function snapshot(id: string): T {
    const raw = read(id);
    const cached = cache.get(id);
    if (cached !== undefined && cached.raw === raw) {
      return cached.value;
    }
    const value = parseOrFallback(raw);
    cache.set(id, { raw, value });
    return value;
  };
}

// ---------------------------------------------------------------------------
// Shared parsers
// ---------------------------------------------------------------------------

/** Strict `parse` for boolean accessors: only "true"/"false" are valid. */
export function parseBool(raw: string): boolean | null {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Static-key accessor
// ---------------------------------------------------------------------------

/**
 * Create a type-safe localStorage accessor for a single key.
 *
 * Export one accessor per key from a shared module; don't re-create at
 * the call site (snapshot caching is per-instance).
 *
 * @example
 * ```ts
 * // utils/pinned-apps-storage.ts
 * export const pinnedApps = createStorageAccessor<PinnedAppEntry[]>({
 *   key: "vellum:pinnedApps",
 *   scope: "user",
 *   parse: parsePinnedApps,
 *   serialize: JSON.stringify,
 *   fallback: [],
 * });
 *
 * // Imperative
 * const apps = pinnedApps.load();
 * pinnedApps.save([...apps, newApp]);
 *
 * // React component
 * function PinCount() {
 *   const apps = pinnedApps.useValue();
 *   return <span>{apps.length}</span>;
 * }
 * ```
 */
export function createStorageAccessor<T>(
  config: StorageAccessorConfig<T>,
): StorageAccessor<T> {
  const { key, scope, parse, serialize, fallback } = config;

  // Cache the last raw string and parsed result so that `getSnapshot`
  // returns the same object reference when the underlying data hasn't
  // changed. Without this, `useSyncExternalStore` would see a new
  // reference on every render call for non-primitive T (arrays, objects)
  // and re-render indefinitely.
  let cachedRaw: string | null | undefined;
  let cachedValue: T = fallback;

  function load(): T {
    const raw = readRaw(key);
    if (raw === cachedRaw) {
      return cachedValue;
    }
    cachedRaw = raw;
    if (raw === null) {
      cachedValue = fallback;
      return fallback;
    }
    try {
      const parsed = parse(raw);
      cachedValue = parsed !== null ? parsed : fallback;
    } catch {
      cachedValue = fallback;
    }
    return cachedValue;
  }

  function save(value: T): void {
    setLocalSetting(key, serialize(value));
  }

  function remove(): void {
    removeLocalSetting(key);
  }

  function subscribe(onStoreChange: () => void): () => void {
    return watchSetting(key, onStoreChange);
  }

  function getSnapshot(): T {
    return load();
  }

  function getServerSnapshot(): T {
    return fallback;
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  }

  return { load, save, remove, key, scope, useValue };
}

// ---------------------------------------------------------------------------
// Per-entity keyed accessor
// ---------------------------------------------------------------------------

/**
 * Create a type-safe localStorage accessor for per-entity keyed storage.
 *
 * Each entity ID maps to its own localStorage key via `keyFn`. For
 * record-based storage with entry-level CRUD and `maxEntries` trimming,
 * use `createRecordStorageAccessor` instead.
 *
 * @example
 * ```ts
 * const drafts = createKeyedStorageAccessor<DraftState>({
 *   keyFn: (id) => `vellum:chatDrafts:${id}`,
 *   scope: "user",
 *   parse: parseDraftState,
 *   serialize: JSON.stringify,
 *   fallback: { text: "", attachments: [] },
 * });
 *
 * const draft = drafts.load(assistantId);
 * drafts.save(assistantId, { text: "hello", attachments: [] });
 * ```
 */
export function createKeyedStorageAccessor<T>(
  config: KeyedStorageAccessorConfig<T>,
): KeyedStorageAccessor<T> {
  const { keyFn, scope, parse, serialize, fallback } = config;

  function parseOrFallback(raw: string | null): T {
    if (raw === null) {
      return fallback;
    }
    try {
      const parsed = parse(raw);
      return parsed !== null ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function load(id: string): T {
    return parseOrFallback(readRaw(keyFn(id)));
  }

  function save(id: string, value: T): void {
    setLocalSetting(keyFn(id), serialize(value));
  }

  function remove(id: string): void {
    removeLocalSetting(keyFn(id));
  }

  const snapshot = createSnapshotCache<T>(
    (id) => readRaw(keyFn(id)),
    parseOrFallback,
  );

  function useValue(id: string): T {
    // Both callbacks are keyed on `id`: a changed entity must resubscribe to
    // the new key, or the hook would keep watching the previous one.
    const subscribe = useCallback(
      (onStoreChange: () => void) => watchSetting(keyFn(id), onStoreChange),
      [id],
    );
    const getSnapshot = useCallback(() => snapshot(id), [id]);
    return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
  }

  return { load, save, remove, keyFn, scope, useValue };
}

// ---------------------------------------------------------------------------
// Record-based keyed accessor (for per-assistant Maps stored as objects)
// ---------------------------------------------------------------------------

export interface RecordStorageAccessorConfig<V> {
  /** Builds the localStorage key from an entity ID. */
  keyFn: (id: string) => string;
  /** `user` keys are cleared on logout; `device` keys are preserved. */
  scope: StorageScope;
  /** Validate a single record value entry. Return `null` for invalid data. */
  parseValue: (raw: unknown) => V | null;
  /** Value returned when the key is absent or unparseable. */
  fallback: Record<string, V>;
  /**
   * Max entries to retain. Oldest are dropped on save by Object insertion
   * order. Only works correctly with non-numeric string keys (numeric keys
   * sort first per ES2015 spec, breaking oldest-first semantics).
   */
  maxEntries?: number;
}

export interface RecordStorageAccessor<V> {
  /** Load the full record for an entity. Returns a fresh object each call; safe to mutate. */
  load: (id: string) => Record<string, V>;
  /** Get a single entry from the record. */
  get: (id: string, entryKey: string) => V | undefined;
  /** Set a single entry in the record (merge, not overwrite). */
  set: (id: string, entryKey: string, value: V) => void;
  /** Remove a single entry from the record. */
  deleteEntry: (id: string, entryKey: string) => void;
  /** Remove the entire record for an entity. */
  remove: (id: string) => void;
  /** Build the localStorage key for a given entity ID. */
  keyFn: (id: string) => string;
  /** The declared scope. */
  scope: StorageScope;
  /**
   * React hook that subscribes to one entity's record. Returns the same
   * reference while the stored text is unchanged, so it is safe to depend on
   * — but for that reason the result must be treated as read-only. Use
   * {@link RecordStorageAccessor.load} when you need a mutable copy.
   */
  useValue: (id: string) => Record<string, V>;
}

/**
 * Create a record-based (Map-like) storage accessor for per-entity data.
 *
 * Stores a `Record<string, V>` per entity. Supports `maxEntries` trimming
 * for bounded storage (oldest entries dropped first by insertion order).
 *
 * @example
 * ```ts
 * const ctxWindow = createRecordStorageAccessor<ContextWindowUsage>({
 *   keyFn: (id) => `vellum:ctxwindow:${id}`,
 *   scope: "user",
 *   parseValue: validateUsage,
 *   fallback: {},
 *   maxEntries: 200,
 * });
 *
 * const usage = ctxWindow.get(assistantId, conversationId);
 * ctxWindow.set(assistantId, conversationId, newUsage);
 * ```
 */
export function createRecordStorageAccessor<V>(
  config: RecordStorageAccessorConfig<V>,
): RecordStorageAccessor<V> {
  const { keyFn, scope, parseValue, fallback, maxEntries } = config;

  function parseRecord(raw: string): Record<string, V> | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const result: Record<string, V> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const validated = parseValue(v);
        if (validated !== null) {
          result[k] = validated;
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  function load(id: string): Record<string, V> {
    const raw = readRaw(keyFn(id));
    if (raw === null) {
      return { ...fallback };
    }
    return parseRecord(raw) ?? { ...fallback };
  }

  function get(id: string, entryKey: string): V | undefined {
    return load(id)[entryKey];
  }

  function set(id: string, entryKey: string, value: V): void {
    const existing = load(id);
    existing[entryKey] = value;

    if (maxEntries !== undefined) {
      const entries = Object.entries(existing);
      if (entries.length > maxEntries) {
        const trimmed = entries.slice(entries.length - maxEntries);
        const trimmedRecord: Record<string, V> = {};
        for (const [k, v] of trimmed) {
          trimmedRecord[k] = v;
        }
        setLocalSetting(keyFn(id), JSON.stringify(trimmedRecord));
        return;
      }
    }

    setLocalSetting(keyFn(id), JSON.stringify(existing));
  }

  function deleteEntry(id: string, entryKey: string): void {
    const existing = load(id);
    delete existing[entryKey];
    setLocalSetting(keyFn(id), JSON.stringify(existing));
  }

  function remove(id: string): void {
    removeLocalSetting(keyFn(id));
  }

  const snapshot = createSnapshotCache<Record<string, V>>(
    (id) => readRaw(keyFn(id)),
    (raw) => (raw === null ? fallback : (parseRecord(raw) ?? fallback)),
  );

  function useValue(id: string): Record<string, V> {
    const subscribe = useCallback(
      (onStoreChange: () => void) => watchSetting(keyFn(id), onStoreChange),
      [id],
    );
    const getSnapshot = useCallback(() => snapshot(id), [id]);
    return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
  }

  return { load, get, set, deleteEntry, remove, keyFn, scope, useValue };
}
