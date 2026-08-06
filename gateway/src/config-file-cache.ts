/**
 * TTL-cached reader for workspace/config.json.
 *
 * Provides typed getters that read from a cached snapshot of the config file.
 * The snapshot is refreshed on demand when the TTL expires, when `force: true`
 * is passed to a getter, or when `refreshNow()` is called explicitly.
 */

import { readConfigFileOrEmpty } from "./config-file-utils.js";

const DEFAULT_TTL_MS = 1000;

type ReadOptions = {
  force?: boolean;
};

/**
 * Iterate entries and keep only those whose value is a non-empty,
 * non-whitespace string. Returns undefined when the input is not
 * a plain object or the result is empty.
 *
 * Normalizes a raw config section into a string-keyed record.
 */
function normalizeRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim() !== "") {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Normalize a list-valued setting into an array of non-empty strings.
 *
 * Accepts either a JSON array or a comma-separated string, so a list reads the
 * same whether it is authored as `["a", "b"]` or `"a,b"`. Returns undefined
 * when the input is neither shape, or when nothing survives normalization.
 *
 * Non-string array entries are dropped rather than coerced. A snowflake
 * authored as a bare JSON integer has already lost precision above 2^53 by the
 * time it reaches this function (LUM-2939), so stringifying it resurrects a
 * corrupted id that still looks well-formed. Dropping it keeps the failure
 * loud instead of silently pointing at the wrong channel.
 */
function normalizeStringList(raw: unknown): string[] | undefined {
  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "string") {
    entries = raw.split(",");
  } else {
    return undefined;
  }

  const result = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return result.length > 0 ? result : undefined;
}

export class ConfigFileCache {
  private ttlMs: number;
  private snapshot: Record<string, unknown> = {};
  private lastReadAt = 0;
  private invalidateCallbacks: Set<() => void> = new Set();

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Read the config file if the cached snapshot is stale or force is set. */
  private ensureFresh(opts?: ReadOptions): void {
    const now = Date.now();
    if (opts?.force || now - this.lastReadAt >= this.ttlMs) {
      this.snapshot = readConfigFileOrEmpty();
      this.lastReadAt = Date.now();
    }
  }

  /** Resolve a section + field path from the cached snapshot. */
  private getRaw(section: string, field: string, opts?: ReadOptions): unknown {
    this.ensureFresh(opts);
    const sec = this.snapshot[section];
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) return undefined;
    return (sec as Record<string, unknown>)[field];
  }

  getString(
    section: string,
    field: string,
    opts?: ReadOptions,
  ): string | undefined {
    const raw = this.getRaw(section, field, opts);
    return typeof raw === "string" ? raw || undefined : undefined;
  }

  getNumber(
    section: string,
    field: string,
    opts?: ReadOptions,
  ): number | undefined {
    const raw = this.getRaw(section, field, opts);
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }

  getBoolean(
    section: string,
    field: string,
    opts?: ReadOptions,
  ): boolean | undefined {
    const raw = this.getRaw(section, field, opts);
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
    return undefined;
  }

  getRecord(
    section: string,
    field: string,
    opts?: ReadOptions,
  ): Record<string, string> | undefined {
    const raw = this.getRaw(section, field, opts);
    return normalizeRecord(raw);
  }

  /**
   * Read a list-valued setting as an array of strings, accepting either a JSON
   * array or a comma-separated string.
   *
   * Both shapes are accepted because the ways a list gets authored produce
   * different types. Hand-editing `config.json` yields an array, and
   * `assistant config set --json` is the only safe way to write a snowflake id
   * (a bare integer above 2^53 is truncated on the way in, LUM-2939), while a
   * CSV setting is a plain string.
   *
   * This is the only getter that reads a list. {@link getString} returns
   * undefined for an array, so an array-shaped list read through it collapses
   * to nothing and a populated setting reads as unset. Route list settings
   * here rather than adding another string-shaped parse.
   */
  getStringArray(
    section: string,
    field: string,
    opts?: ReadOptions,
  ): string[] | undefined {
    return normalizeStringList(this.getRaw(section, field, opts));
  }

  /** Immediately re-read config.json, updating the cached snapshot. */
  refreshNow(): void {
    this.snapshot = readConfigFileOrEmpty();
    this.lastReadAt = Date.now();
  }

  /** Mark the cache as stale and notify invalidation listeners. */
  invalidate(): void {
    this.lastReadAt = 0;
    for (const cb of this.invalidateCallbacks) {
      cb();
    }
  }

  /**
   * Register a callback that fires when `invalidate()` is called.
   * Returns an unsubscribe function.
   */
  onInvalidate(cb: () => void): () => void {
    this.invalidateCallbacks.add(cb);
    return () => {
      this.invalidateCallbacks.delete(cb);
    };
  }
}
