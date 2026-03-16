import { getLogger } from "../util/logger.js";

const log = getLogger("conversation-evictor");

/** Minimal interface a conversation must satisfy to be evictable. */
export interface EvictableConversation {
  isProcessing(): boolean;
  dispose(): void;
}

export interface EvictorOptions {
  /** Max idle time before a conversation is eligible for eviction (ms). Default: 30 min. */
  ttlMs?: number;
  /** Max number of in-memory conversations before LRU eviction kicks in. Default: 100. */
  maxConversations?: number;
  /** RSS threshold (bytes) above which idle conversations are aggressively evicted. Default: 3 GB. */
  memoryThresholdBytes?: number;
  /** Interval between periodic sweeps (ms). Default: 60 s. */
  sweepIntervalMs?: number;
}

export interface EvictionResult {
  /** Conversations evicted because they exceeded TTL. */
  ttlEvicted: number;
  /** Conversations evicted because pool exceeded maxConversations (LRU order). */
  lruEvicted: number;
  /** Conversations evicted due to memory pressure. */
  memoryEvicted: number;
  /** Conversations skipped because they were actively processing. */
  skipped: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_CONVERSATIONS = 100;
const DEFAULT_MEMORY_THRESHOLD_BYTES = 3072 * 1024 * 1024; // 3 GB
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

export class ConversationEvictor {
  private readonly ttlMs: number;
  private readonly maxConversations: number;
  private readonly memoryThresholdBytes: number;
  private readonly sweepIntervalMs: number;

  /** Tracks last access time per conversation ID. */
  private lastAccess = new Map<string, number>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private conversations: Map<string, EvictableConversation>;

  /** Optional hook called for each evicted conversation (for cleanup in DaemonServer). */
  onEvict?: (conversationId: string) => void;

  /** Optional guard: if this returns true, the conversation is protected from eviction. */
  shouldProtect?: (conversationId: string) => boolean;

  constructor(
    conversations: Map<string, EvictableConversation>,
    options?: EvictorOptions,
  ) {
    this.conversations = conversations;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxConversations =
      options?.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.memoryThresholdBytes =
      options?.memoryThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES;
    this.sweepIntervalMs =
      options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Record an access for the given conversation (resets its idle clock). */
  touch(conversationId: string): void {
    this.lastAccess.set(conversationId, Date.now());
  }

  /** Remove tracking state for a conversation that was externally removed. */
  remove(conversationId: string): void {
    this.lastAccess.delete(conversationId);
  }

  /** Start the periodic sweep timer. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        const result = this.sweep();
        const total =
          result.ttlEvicted + result.lruEvicted + result.memoryEvicted;
        if (total > 0) {
          log.info(result, "Conversation eviction sweep completed");
        }
      } catch (err) {
        log.error({ err }, "Conversation eviction sweep failed");
      }
    }, this.sweepIntervalMs);
  }

  /** Stop the periodic sweep timer. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.lastAccess.clear();
  }

  /**
   * Run a single eviction sweep. Safe to call manually (e.g. from tests)
   * in addition to the periodic timer.
   */
  sweep(): EvictionResult {
    const now = Date.now();
    const result: EvictionResult = {
      ttlEvicted: 0,
      lruEvicted: 0,
      memoryEvicted: 0,
      skipped: 0,
    };

    // Phase 1: TTL eviction — remove conversations idle longer than ttlMs.
    for (const [id, conversation] of this.conversations) {
      const lastAccessTime = this.lastAccess.get(id) ?? 0;
      if (now - lastAccessTime < this.ttlMs) continue;
      if (conversation.isProcessing() || this.shouldProtect?.(id)) {
        result.skipped++;
        continue;
      }
      this.evict(id, conversation);
      result.ttlEvicted++;
    }

    // Phase 2: LRU eviction — if still over capacity, evict least-recently-used.
    if (this.conversations.size > this.maxConversations) {
      const sorted = this.idleConversationsByLru();
      for (const [id, conversation] of sorted) {
        if (this.conversations.size <= this.maxConversations) break;
        this.evict(id, conversation);
        result.lruEvicted++;
      }
    }

    // Phase 3: Memory pressure — if RSS exceeds threshold, evict idle conversations
    // starting from least-recently-used until we're under the threshold or
    // no more idle conversations remain.
    const rss = process.memoryUsage.rss();
    if (rss > this.memoryThresholdBytes) {
      const sorted = this.idleConversationsByLru();
      if (sorted.length > 0) {
        log.warn(
          {
            rssBytes: rss,
            thresholdBytes: this.memoryThresholdBytes,
            conversationCount: this.conversations.size,
          },
          "Memory pressure detected, evicting idle conversations",
        );
        for (const [id, conversation] of sorted) {
          if (process.memoryUsage.rss() <= this.memoryThresholdBytes) break;
          this.evict(id, conversation);
          result.memoryEvicted++;
        }
      }
    }

    // Clean up stale lastAccess entries for conversations that no longer exist
    // (e.g. removed by clearAllConversations or evictConversationsForReload).
    for (const id of this.lastAccess.keys()) {
      if (!this.conversations.has(id)) {
        this.lastAccess.delete(id);
      }
    }

    return result;
  }

  /** Current number of tracked conversations (for diagnostics). */
  get trackedCount(): number {
    return this.lastAccess.size;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private evict(id: string, conversation: EvictableConversation): void {
    conversation.dispose();
    this.conversations.delete(id);
    this.lastAccess.delete(id);
    this.onEvict?.(id);
    log.debug({ conversationId: id }, "Evicted idle conversation");
  }

  /**
   * Return idle (non-processing) conversations sorted by last access time
   * ascending (least recently used first).
   */
  private idleConversationsByLru(): Array<[string, EvictableConversation]> {
    const idle: Array<[string, EvictableConversation, number]> = [];
    for (const [id, conversation] of this.conversations) {
      if (conversation.isProcessing()) continue;
      if (this.shouldProtect?.(id)) continue;
      idle.push([id, conversation, this.lastAccess.get(id) ?? 0]);
    }
    idle.sort((a, b) => a[2] - b[2]);
    return idle.map(([id, conversation]) => [id, conversation]);
  }
}
