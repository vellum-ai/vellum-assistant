import { type CharacterTraits, isCharacterTraits } from "@/types/avatar";

/**
 * Last-seen avatar cache in IndexedDB, keyed by assistant id. Lets a chooser
 * row keep showing an avatar it has rendered before while the assistant is
 * unreachable and no live source can answer. Characters store their traits
 * (the row re-renders the real SVG); images store the Blob itself, which is
 * structured-clone safe, and the reader mints a fresh object URL.
 *
 * Every entry point is best-effort: no IndexedDB (private windows, tests),
 * a blocked open, or a failed transaction all resolve to `null` / no-op.
 */

export type LastSeenAvatar =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image"; blob: Blob };

type StoredAvatar = LastSeenAvatar & { id: string; updatedAt: number };

const DB_NAME = "vellum-avatar-cache";
const DB_VERSION = 1;
const STORE_NAME = "avatars";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: "id" });
    }
  };
  return requestToPromise(request);
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  try {
    const db = await openDatabase();
    try {
      const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
      return await requestToPromise(operation(store));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function toLastSeenAvatar(value: unknown): LastSeenAvatar | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Partial<StoredAvatar>;
  if (record.kind === "character" && isCharacterTraits(record.traits)) {
    return { kind: "character", traits: record.traits };
  }
  if (record.kind === "image" && record.blob instanceof Blob) {
    return { kind: "image", blob: record.blob };
  }
  return null;
}

export async function readLastSeenAvatar(
  assistantId: string,
): Promise<LastSeenAvatar | null> {
  const record = await withStore("readonly", (store) => store.get(assistantId));
  return toLastSeenAvatar(record);
}

/**
 * Per-assistant persistence generation. Every write or delete claims the
 * next one; a caller that did async work before committing (e.g. reading a
 * blob) passes its claimed generation and is dropped if a newer operation
 * has claimed since, so the last-issued operation always wins.
 */
const generations = new Map<string, number>();

export function claimLastSeenAvatarGeneration(assistantId: string): number {
  const generation = (generations.get(assistantId) ?? 0) + 1;
  generations.set(assistantId, generation);
  return generation;
}

export function isLastSeenAvatarGenerationCurrent(
  assistantId: string,
  generation: number,
): boolean {
  return generations.get(assistantId) === generation;
}

export async function writeLastSeenAvatar(
  assistantId: string,
  avatar: LastSeenAvatar,
  generation = claimLastSeenAvatarGeneration(assistantId),
): Promise<void> {
  if (!isLastSeenAvatarGenerationCurrent(assistantId, generation)) {
    return;
  }
  const record: StoredAvatar = {
    ...avatar,
    id: assistantId,
    updatedAt: Date.now(),
  };
  await withStore("readwrite", (store) => store.put(record));
}

export async function deleteLastSeenAvatar(
  assistantId: string,
  generation = claimLastSeenAvatarGeneration(assistantId),
): Promise<void> {
  if (!isLastSeenAvatarGenerationCurrent(assistantId, generation)) {
    return;
  }
  await withStore("readwrite", (store) => store.delete(assistantId));
}
