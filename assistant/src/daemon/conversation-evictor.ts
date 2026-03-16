import { getLogger } from "../util/logger.js";

const log = getLogger("session-evictor");

/** Minimal interface a session must satisfy to be evictable. */
export interface EvictableConversation {
  isProcessing(): boolean;
  dispose(): void;
}

export interface EvictorOptions {
  /** Max idle time before a session is eligible for eviction (ms). Default: 30 min. */
  ttlMs?: number;
  /** Max number of in-memory sessions before LRU eviction kicks in. Default: 100. */
  maxSessions?: number;
  /** RSS threshold (bytes) above which idle sessions are aggressively evicted. Default: 3 GB. */
  memoryThresholdBytes?: number;
  /** Interval between periodic sweeps (ms). Default: 60 s. */
  sweepIntervalMs?: number;
}

export interface EvictionResult {
  /** Sessions evicted because they exceeded TTL. */
  ttlEvicted: number;
  /** Sessions evicted because pool exceeded maxSessions (LRU order). */
  lruEvicted: number;
  /** Sessions evicted due to memory pressure. */
  memoryEvicted: number;
  /** Sessions skipped because they were actively processing. */
  skipped: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MEMORY_THRESHOLD_BYTES = 3072 * 1024 * 1024; // 3 GB
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

export class ConversationEvictor {
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly memoryThresholdBytes: number;
  private readonly sweepIntervalMs: number;

  /** Tracks last access time per session ID. */
  private lastAccess = new Map<string, number>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sessions: Map<string, EvictableConversation>;

  /** Optional hook called for each evicted session (for cleanup in DaemonServer). */
  onEvict?: (sessionId: string) => void;

  /** Optional guard: if this returns true, the session is protected from eviction. */
  shouldProtect?: (sessionId: string) => boolean;

  constructor(
    sessions: Map<string, EvictableConversation>,
    options?: EvictorOptions,
  ) {
    this.sessions = sessions;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.memoryThresholdBytes =
      options?.memoryThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES;
    this.sweepIntervalMs =
      options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Record an access for the given session (resets its idle clock). */
  touch(sessionId: string): void {
    this.lastAccess.set(sessionId, Date.now());
  }

  /** Remove tracking state for a session that was externally removed. */
  remove(sessionId: string): void {
    this.lastAccess.delete(sessionId);
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

    // Phase 1: TTL eviction — remove sessions idle longer than ttlMs.
    for (const [id, session] of this.sessions) {
      const lastAccessTime = this.lastAccess.get(id) ?? 0;
      if (now - lastAccessTime < this.ttlMs) continue;
      if (session.isProcessing() || this.shouldProtect?.(id)) {
        result.skipped++;
        continue;
      }
      this.evict(id, session);
      result.ttlEvicted++;
    }

    // Phase 2: LRU eviction — if still over capacity, evict least-recently-used.
    if (this.sessions.size > this.maxSessions) {
      const sorted = this.idleSessionsByLru();
      for (const [id, session] of sorted) {
        if (this.sessions.size <= this.maxSessions) break;
        this.evict(id, session);
        result.lruEvicted++;
      }
    }

    // Phase 3: Memory pressure — if RSS exceeds threshold, evict idle sessions
    // starting from least-recently-used until we're under the threshold or
    // no more idle sessions remain.
    const rss = process.memoryUsage.rss();
    if (rss > this.memoryThresholdBytes) {
      const sorted = this.idleSessionsByLru();
      if (sorted.length > 0) {
        log.warn(
          {
            rssBytes: rss,
            thresholdBytes: this.memoryThresholdBytes,
            sessionCount: this.sessions.size,
          },
          "Memory pressure detected, evicting idle sessions",
        );
        for (const [id, session] of sorted) {
          if (process.memoryUsage.rss() <= this.memoryThresholdBytes) break;
          this.evict(id, session);
          result.memoryEvicted++;
        }
      }
    }

    // Clean up stale lastAccess entries for sessions that no longer exist
    // (e.g. removed by clearAllConversations or evictSessionsForReload).
    for (const id of this.lastAccess.keys()) {
      if (!this.sessions.has(id)) {
        this.lastAccess.delete(id);
      }
    }

    return result;
  }

  /** Current number of tracked sessions (for diagnostics). */
  get trackedCount(): number {
    return this.lastAccess.size;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private evict(id: string, session: EvictableConversation): void {
    session.dispose();
    this.sessions.delete(id);
    this.lastAccess.delete(id);
    this.onEvict?.(id);
    log.debug({ sessionId: id }, "Evicted idle session");
  }

  /**
   * Return idle (non-processing) sessions sorted by last access time
   * ascending (least recently used first).
   */
  private idleSessionsByLru(): Array<[string, EvictableConversation]> {
    const idle: Array<[string, EvictableConversation, number]> = [];
    for (const [id, session] of this.sessions) {
      if (session.isProcessing()) continue;
      if (this.shouldProtect?.(id)) continue;
      idle.push([id, session, this.lastAccess.get(id) ?? 0]);
    }
    idle.sort((a, b) => a[2] - b[2]);
    return idle.map(([id, session]) => [id, session]);
  }
}
