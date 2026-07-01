/**
 * CES in-memory temporary grant store.
 *
 * Manages grants for `allow_once`, `allow_10m`, and `allow_conversation` decisions.
 * All state is in-memory — temporary grants never survive a process restart,
 * which is the desired behaviour for ephemeral approvals.
 *
 * Keying:
 * - `allow_once`: Keyed by proposal hash. Consumed (deleted) on first use, and
 *   bounded by a short default TTL so an approval that is never consumed cannot
 *   linger and be replayed long after the guardian approved the imminent
 *   operation (see ATL-935).
 * - `allow_10m`: Keyed by proposal hash. Checked for expiry on every read;
 *   expired entries are lazily purged.
 * - `allow_conversation`: Keyed by proposal hash + conversation ID. Scoped to a
 *   single conversation and bounded by a generous absolute TTL backstop so an
 *   approval cannot live for the store's entire (process-long) lifetime and be
 *   replayed by a later connection that presents the same conversation ID
 *   (see ATL-935).
 *
 * Lifetime note: in managed mode this store instance is process-scoped and
 * deliberately shared across assistant reconnects — and, in the forthcoming
 * multi-process daemon model, across the multiple connections that each talk to
 * CES — so a single guardian approval can be used by any connection entitled to
 * it. Grant lifetime is therefore bounded by per-grant TTLs rather than by
 * connection teardown: every grant kind carries an expiry, so an unconsumed
 * approval expires on its own instead of surviving indefinitely. (A future
 * multi-connection daemon may additionally evict on quiescence — when the count
 * of live CES connections reaches zero — to scope grants to assistant presence;
 * that is connection-lifecycle machinery the multi-connection work should own,
 * and is intentionally not built here.)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemporaryGrantKind = "allow_once" | "allow_10m" | "allow_conversation";

export interface TemporaryGrant {
  /** The kind of temporary grant. */
  kind: TemporaryGrantKind;
  /** Canonical proposal hash identifying the operation being granted. */
  proposalHash: string;
  /** Conversation ID — required for `allow_conversation`, ignored otherwise. */
  conversationId?: string;
  /** When the grant was created (epoch ms). */
  createdAt: number;
  /** When the grant expires (epoch ms). Set for every grant kind: a short
   *  default for `allow_once`, the timed window for `allow_10m`, and a generous
   *  absolute backstop for `allow_conversation`. */
  expiresAt?: number;
}

/** Default TTL for timed grants (10 minutes). */
const DEFAULT_TIMED_DURATION_MS = 10 * 60 * 1000;

/**
 * Default TTL for single-use (`allow_once`) grants (2 minutes).
 *
 * `allow_once` exists to bridge the gap between a guardian approval and the
 * caller immediately retrying the just-approved operation. Without a TTL, an
 * approval that is never consumed (e.g. the assistant connection drops before
 * the retry) would live for the store's entire lifetime and could later be
 * replayed without a fresh prompt (ATL-935). A short bound keeps the grant
 * usable for a prompt retry while ensuring a stale, unconsumed approval
 * expires on its own.
 */
const DEFAULT_ONCE_DURATION_MS = 2 * 60 * 1000;

/**
 * Absolute TTL backstop for `allow_conversation` grants (12 hours).
 *
 * `allow_conversation` is scoped to a conversation ID and is meant to persist
 * for the life of that conversation, so it is not consumed on use and has no
 * short timeout. But without any bound it would live for the store's entire
 * process-long lifetime and could be replayed by a later connection that
 * presents the same conversation ID long after the original approval (ATL-935).
 * A generous backstop keeps the grant usable across a normal working session
 * while ensuring a long-stale approval eventually requires a fresh prompt.
 */
const DEFAULT_CONVERSATION_DURATION_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

/**
 * Compute the storage key for a temporary grant.
 *
 * - `allow_once` / `allow_10m`: keyed by proposal hash alone.
 * - `allow_conversation`: keyed by proposal hash + conversation ID.
 */
function storageKey(
  kind: TemporaryGrantKind,
  proposalHash: string,
  conversationId?: string,
): string {
  if (kind === "allow_conversation") {
    if (!conversationId) {
      throw new Error(
        "allow_conversation grants require a conversationId",
      );
    }
    return `conversation:${conversationId}:${proposalHash}`;
  }
  return `${kind}:${proposalHash}`;
}

export class TemporaryGrantStore {
  private readonly store = new Map<string, TemporaryGrant>();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Record a temporary grant.
   *
   * For `allow_once` and `allow_10m`, if a grant with the same proposal
   * hash already exists, it is replaced (last-write-wins).
   *
   * @param kind - The type of temporary grant.
   * @param proposalHash - Canonical hash of the operation proposal.
   * @param options - Additional options (conversationId for conversation grants,
   *   custom duration for timed grants).
   */
  add(
    kind: TemporaryGrantKind,
    proposalHash: string,
    options?: {
      conversationId?: string;
      durationMs?: number;
    },
  ): void {
    const key = storageKey(kind, proposalHash, options?.conversationId);

    const grant: TemporaryGrant = {
      kind,
      proposalHash,
      createdAt: Date.now(),
    };

    if (options?.conversationId) {
      grant.conversationId = options.conversationId;
    }

    if (kind === "allow_10m") {
      grant.expiresAt =
        Date.now() + (options?.durationMs ?? DEFAULT_TIMED_DURATION_MS);
    } else if (kind === "allow_once") {
      // `allow_once` is always bounded by a TTL — a caller-supplied duration
      // when present, otherwise a short default — so an unconsumed single-use
      // approval cannot be replayed indefinitely (ATL-935).
      grant.expiresAt =
        Date.now() + (options?.durationMs ?? DEFAULT_ONCE_DURATION_MS);
    } else if (kind === "allow_conversation") {
      // `allow_conversation` persists for the conversation and is not consumed
      // on use, but it still carries a generous absolute TTL backstop so a
      // conversation-scoped approval cannot linger for the store's entire
      // process lifetime and be replayed by a later connection (ATL-935).
      grant.expiresAt =
        Date.now() + (options?.durationMs ?? DEFAULT_CONVERSATION_DURATION_MS);
    }

    this.store.set(key, grant);
  }

  /**
   * Check whether an active temporary grant exists for the given proposal.
   *
   * - `allow_once`: Returns `true` and **consumes** the grant (deletes it).
   * - `allow_10m`: Returns `true` only if the grant has not expired.
   *   Expired grants are lazily purged.
   * - `allow_conversation`: Returns `true` only if a non-expired grant exists
   *   for the given proposal hash scoped to the specified conversation ID.
   *   Expired grants (past the absolute TTL backstop) are lazily purged.
   *
   * Returns `false` if no matching grant exists.
   */
  check(
    kind: TemporaryGrantKind,
    proposalHash: string,
    conversationId?: string,
  ): boolean {
    const key = storageKey(kind, proposalHash, conversationId);
    const grant = this.store.get(key);
    if (!grant) return false;

    if (grant.kind === "allow_once") {
      // Check TTL if set
      if (grant.expiresAt !== undefined && Date.now() >= grant.expiresAt) {
        this.store.delete(key);
        return false;
      }
      // Consume on first use
      this.store.delete(key);
      return true;
    }

    if (grant.kind === "allow_10m") {
      if (grant.expiresAt !== undefined && Date.now() >= grant.expiresAt) {
        // Expired — purge and deny
        this.store.delete(key);
        return false;
      }
      return true;
    }

    // allow_conversation — bounded by an absolute TTL backstop; lazily purge an
    // expired grant and deny, mirroring allow_10m.
    if (grant.expiresAt !== undefined && Date.now() >= grant.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Check whether any kind of active temporary grant exists for the given
   * proposal hash and optional conversation ID.
   *
   * Checks `allow_once`, `allow_10m`, and `allow_conversation` in order.
   * Returns the kind of the matched grant, or `undefined` if none match.
   *
   * Note: If an `allow_once` grant matches, it is consumed.
   */
  checkAny(
    proposalHash: string,
    conversationId?: string,
  ): TemporaryGrantKind | undefined {
    // Check allow_once first (most specific / single-use)
    if (this.check("allow_once", proposalHash)) return "allow_once";

    // Check allow_10m
    if (this.check("allow_10m", proposalHash)) return "allow_10m";

    // Check allow_conversation (requires conversationId)
    if (conversationId && this.check("allow_conversation", proposalHash, conversationId)) {
      return "allow_conversation";
    }

    return undefined;
  }

  /**
   * Remove a specific temporary grant.
   *
   * Returns `true` if the grant existed and was removed.
   */
  remove(
    kind: TemporaryGrantKind,
    proposalHash: string,
    conversationId?: string,
  ): boolean {
    const key = storageKey(kind, proposalHash, conversationId);
    return this.store.delete(key);
  }

  /**
   * Remove all temporary grants for a given conversation ID.
   *
   * Useful when a conversation ends. Only removes `allow_conversation`
   * grants scoped to that conversation.
   */
  clearConversation(conversationId: string): void {
    const prefix = `conversation:${conversationId}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Remove all temporary grants. Useful for testing or full reset.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Return the number of currently stored grants (including expired ones
   * that haven't been lazily purged yet).
   */
  get size(): number {
    return this.store.size;
  }
}
