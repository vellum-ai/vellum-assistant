/**
 * TTL-cached wrapper around readCredentialResult(account) that provides
 * per-key caching with in-flight deduplication, force refresh,
 * and invalidation with watcher hooks.
 *
 * A vault outage must not look like a missing credential. When the reader
 * reports `unreachable`, the cache keeps the last successful value so
 * webhook verification and outbound channel calls keep working.
 */

import { readCredentialResult } from "./credential-reader.js";
import { getLogger } from "./logger.js";

const log = getLogger("credential-cache");

interface CacheEntry {
  value: string | undefined;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 2_000;

export class CredentialCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight promises keyed by credential account, used for deduplication. */
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly invalidateListeners = new Set<() => void>();
  private generation = 0;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Get a credential value by key. Returns a cached value if the TTL
   * has not expired, otherwise fetches from the underlying credential
   * reader. Concurrent requests for the same key coalesce into a
   * single read.
   *
   * Pass `force: true` to bypass the TTL and always fetch fresh.
   */
  async get(
    key: string,
    opts?: { force?: boolean },
  ): Promise<string | undefined> {
    const force = opts?.force ?? false;

    if (!force) {
      const cached = this.cache.get(key);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
      }
    }

    return this.fetch(key);
  }

  /**
   * Immediately re-fetch and cache the given keys (or all currently
   * cached keys if none are specified). This updates cached values
   * without waiting for the next read to trigger a refresh.
   */
  async refreshNow(keys?: string[]): Promise<void> {
    const toRefresh = keys ?? [...this.cache.keys()];
    await Promise.all(toRefresh.map((key) => this.fetch(key)));
  }

  /**
   * Clear all cached entries and in-flight promises, then notify
   * all registered invalidation listeners.
   */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    for (const cb of this.invalidateListeners) {
      cb();
    }
  }

  /**
   * Register a callback to be invoked when the cache is invalidated.
   * Returns an unsubscribe function.
   */
  onInvalidate(cb: () => void): () => void {
    this.invalidateListeners.add(cb);
    return () => {
      this.invalidateListeners.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Fetch a credential, coalescing concurrent requests for the same key.
   */
  private fetch(key: string): Promise<string | undefined> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const gen = this.generation;
    const promise = readCredentialResult(key).then(
      (result) => {
        if (this.generation !== gen) {
          return result.unreachable ? undefined : result.value;
        }
        this.inflight.delete(key);

        if (result.unreachable) {
          const previous = this.cache.get(key);
          if (previous && previous.value !== undefined) {
            log.warn(
              { account: key },
              "credential vault unreachable; using last known value",
            );
            this.cache.set(key, {
              value: previous.value,
              expiresAt: Date.now() + this.ttlMs,
            });
            return previous.value;
          }
          this.cache.set(key, {
            value: undefined,
            expiresAt: Date.now() + this.ttlMs,
          });
          return undefined;
        }

        this.cache.set(key, {
          value: result.value,
          expiresAt: Date.now() + this.ttlMs,
        });
        return result.value;
      },
      (err) => {
        if (this.generation === gen) {
          this.inflight.delete(key);
        }
        throw err;
      },
    );

    this.inflight.set(key, promise);
    return promise;
  }
}
