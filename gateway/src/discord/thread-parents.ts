/**
 * Thread → parent-channel resolution for the Discord Gateway client.
 *
 * Discord delivers thread messages as ordinary MESSAGE_CREATE events whose
 * `channel_id` is the *thread's* snowflake, and the bot is auto-subscribed to
 * every visible active thread without joining. The admission gate's allow-list
 * names parent channels, so it needs parentage resolved before the check —
 * without it, every thread message silently fails `channel_not_allowed`
 * (see `admit.ts`).
 *
 * Parentage arrives on channel objects: GUILD_CREATE carries the guild's
 * active threads, THREAD_CREATE / THREAD_UPDATE carry the thread itself, and
 * THREAD_LIST_SYNC re-lists them after the client regains channel visibility.
 * All of those are subscribed under the GUILDS intent this client identifies
 * with.
 */

/**
 * Discord channel types that are threads. Only these enter the cache: a
 * regular channel also carries a `parent_id`, but it points at its *category*,
 * and recording it would make a message in the channel "inherit" the
 * category's allow-list entry.
 *
 * https://docs.discord.com/developers/resources/channel#channel-object-channel-types
 */
const THREAD_CHANNEL_TYPES = new Set([
  10, // ANNOUNCEMENT_THREAD
  11, // PUBLIC_THREAD
  12, // PRIVATE_THREAD
]);

/** The fields of a Discord channel object this cache reads. */
export interface ThreadParentCandidate {
  id?: string;
  type?: number;
  parent_id?: string | null;
}

/**
 * Bound on cached thread parentages. A busy community produces threads
 * indefinitely and the client lives for weeks, so the map cannot grow
 * unbounded; eviction is insertion-ordered, which approximates
 * least-recently-created — the threads most likely to still be active are the
 * ones kept.
 */
const MAX_TRACKED_THREADS = 10_000;

export class ThreadParentCache {
  private readonly parents = new Map<string, string>();

  /**
   * Record a channel object if it is a thread with a parent. Non-thread
   * channels and malformed objects are ignored, so every channel in a
   * GUILD_CREATE can be fed through without pre-filtering.
   */
  note(channel: ThreadParentCandidate): void {
    if (
      channel.id === undefined ||
      channel.type === undefined ||
      !THREAD_CHANNEL_TYPES.has(channel.type) ||
      typeof channel.parent_id !== "string" ||
      channel.parent_id.length === 0
    ) {
      return;
    }
    // Re-insert so long-lived active threads migrate toward the young end of
    // the eviction order.
    this.parents.delete(channel.id);
    this.parents.set(channel.id, channel.parent_id);
    if (this.parents.size > MAX_TRACKED_THREADS) {
      const oldest = this.parents.keys().next().value;
      if (oldest !== undefined) {
        this.parents.delete(oldest);
      }
    }
  }

  /** Record every thread in a list (GUILD_CREATE / THREAD_LIST_SYNC). */
  noteAll(channels: readonly ThreadParentCandidate[] | undefined): void {
    for (const channel of channels ?? []) {
      this.note(channel);
    }
  }

  /** Forget a deleted thread. Unknown ids are a no-op. */
  forget(channelId: string | undefined): void {
    if (channelId !== undefined) {
      this.parents.delete(channelId);
    }
  }

  /**
   * The parent channel of a thread, or undefined when `channelId` is not a
   * known thread — which includes regular channels, so the caller can pass
   * every message's `channel_id` through unconditionally.
   */
  parentOf(channelId: string): string | undefined {
    return this.parents.get(channelId);
  }

  /** Number of tracked threads. Exposed for tests and diagnostics. */
  get size(): number {
    return this.parents.size;
  }
}
