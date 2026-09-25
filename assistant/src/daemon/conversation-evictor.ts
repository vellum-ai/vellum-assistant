import { getSubagentManager } from "../subagent/index.js";
import { getContainerMemoryLimitBytes } from "../util/cgroup-memory.js";
import { getLogger } from "../util/logger.js";
import { getConversationMap } from "./conversation-registry.js";

const log = getLogger("conversation-evictor");

/** Minimal interface a conversation must satisfy to be evictable. */
export interface EvictableConversation {
  hasInFlightWork(): boolean;
  dispose(): void;
}

export interface EvictorOptions {
  /** Max idle time before a conversation is eligible for eviction (ms). Default: 30 min. */
  ttlMs?: number;
  /** Max number of in-memory conversations before LRU eviction kicks in. Default: 100. */
  maxConversations?: number;
  /** RSS threshold (bytes) above which idle conversations are aggressively evicted. Default: {@link defaultMemoryThresholdBytes}. */
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
  /** Conversations skipped because they retained in-flight work. */
  skipped: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_CONVERSATIONS = 100;
/** Threshold when no container limit is known (local hosts). */
const FALLBACK_MEMORY_THRESHOLD_BYTES = 3072 * 1024 * 1024; // 3 GiB
/**
 * Share of the container memory limit the daemon's own RSS may reach before
 * idle conversations are evicted. The rest of the limit is Qdrant, the
 * workers, and tool children, so the daemon cannot have it all.
 */
const MEMORY_THRESHOLD_LIMIT_FRACTION = 0.5;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds
/**
 * Idle conversations evicted per sweep under memory pressure. RSS cannot fall
 * until the disposed heap is collected after the sweep returns, so the sweep
 * evicts a bounded batch and the next sweep re-measures.
 */
const MEMORY_EVICTION_BATCH = 10;

/** Default memory-pressure threshold: half the container limit, or 3 GiB when there is none. */
export function defaultMemoryThresholdBytes(limitBytes: number | null): number {
  return limitBytes != null
    ? Math.floor(limitBytes * MEMORY_THRESHOLD_LIMIT_FRACTION)
    : FALLBACK_MEMORY_THRESHOLD_BYTES;
}

export class ConversationEvictor {
  private readonly ttlMs: number;
  private readonly maxConversations: number;
  /** Explicit threshold, or null to derive it from the container limit on first use. */
  private memoryThresholdBytes: number | null;
  private readonly sweepIntervalMs: number;

  /** Tracks last access time per conversation ID. */
  private lastAccess = new Map<string, number>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private conversations: Map<string, EvictableConversation>;

  constructor(
    conversations: Map<string, EvictableConversation>,
    options?: EvictorOptions,
  ) {
    this.conversations = conversations;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxConversations =
      options?.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.memoryThresholdBytes = options?.memoryThresholdBytes ?? null;
    this.sweepIntervalMs =
      options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * Abort any in-flight subagents belonging to a conversation as it's evicted.
   * Terminal subagent metadata is left readable — an evicted conversation is
   * resumable from the database, and its next turn may still `subagent_read` a
   * completed child's result.
   */
  onEvict(conversationId: string): void {
    getSubagentManager().abortAllForParent(conversationId);
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
    if (this.sweepTimer) {
      return;
    }
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
    // A conversation with queued messages is not idle: the queue drains via an
    // async dispatch after the current turn's `finally`, so `isProcessing()`
    // can read false while a queued turn (e.g. a subagent completion wake) is
    // still pending. Disposing in that gap would silently drop the queued
    // messages.
    for (const [id, conversation] of this.conversations) {
      const lastAccessTime = this.lastAccess.get(id) ?? 0;
      if (now - lastAccessTime < this.ttlMs) {
        continue;
      }
      if (conversation.hasInFlightWork()) {
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
        if (this.conversations.size <= this.maxConversations) {
          break;
        }
        this.evict(id, conversation);
        result.lruEvicted++;
      }
    }

    // Phase 3: Memory pressure — if RSS exceeds threshold, evict a batch of
    // idle conversations starting from least-recently-used.
    const rss = process.memoryUsage.rss();
    const thresholdBytes = this.resolveMemoryThresholdBytes();
    if (rss > thresholdBytes) {
      const batch = this.idleConversationsByLru().slice(
        0,
        MEMORY_EVICTION_BATCH,
      );
      if (batch.length > 0) {
        log.warn(
          {
            rssBytes: rss,
            thresholdBytes,
            conversationCount: this.conversations.size,
            evicting: batch.length,
          },
          "Memory pressure detected, evicting idle conversations",
        );
        for (const [id, conversation] of batch) {
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

  /**
   * Resolved on first sweep rather than at construction: the module-level
   * singleton is built at import, before the daemon has loaded its dotenv
   * file, and VELLUM_MEMORY_LIMIT may come from there.
   */
  private resolveMemoryThresholdBytes(): number {
    this.memoryThresholdBytes ??= defaultMemoryThresholdBytes(
      getContainerMemoryLimitBytes(),
    );
    return this.memoryThresholdBytes;
  }

  private evict(id: string, conversation: EvictableConversation): void {
    conversation.dispose();
    this.conversations.delete(id);
    this.lastAccess.delete(id);
    this.onEvict(id);
    log.debug({ conversationId: id }, "Evicted idle conversation");
  }

  /** Return evictable conversations in least-recently-used order. */
  private idleConversationsByLru(): Array<[string, EvictableConversation]> {
    const idle: Array<[string, EvictableConversation, number]> = [];
    for (const [id, conversation] of this.conversations) {
      if (conversation.hasInFlightWork()) {
        continue;
      }
      idle.push([id, conversation, this.lastAccess.get(id) ?? 0]);
    }
    idle.sort((a, b) => a[2] - b[2]);
    return idle.map(([id, conversation]) => [id, conversation]);
  }
}

// ── Process-level singleton ───────────────────────────────────────────────

/** Daemon-wide evictor over the in-memory conversation pool. */
const evictor = new ConversationEvictor(getConversationMap());

/** Record an access so the conversation's idle clock resets. */
export function touchConversation(conversationId: string): void {
  evictor.touch(conversationId);
}

/** Drop a conversation's eviction tracking (it was removed elsewhere). */
export function removeFromEvictor(conversationId: string): void {
  evictor.remove(conversationId);
}

/** Start the periodic eviction sweep at daemon startup. */
export function startConversationEvictor(): void {
  evictor.start();
}

/** Stop the eviction sweep during daemon shutdown. */
export function stopConversationEvictor(): void {
  evictor.stop();
}
