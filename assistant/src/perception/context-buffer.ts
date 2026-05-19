/**
 * Daemon-side ring buffer of perception events.
 *
 * The buffer subscribes to {@link AssistantEventHub} as a process-typed
 * subscriber, recognises events whose outer `message.type` begins with
 * `perception.`, validates them against the perception schema, and stores
 * the parsed payload + receive time.
 *
 * Memory-only by design. Entries are evicted when:
 *   - the buffer is at capacity (oldest pruned on insert), or
 *   - a stored entry has aged past `ttlMs` (pruned lazily on insert/query).
 *
 * Phase 1 ships only as the storage layer; the agent-facing query path
 * (`getRecentContext`) is added in a follow-up via a skill IPC route, so
 * this module intentionally exposes no global accessors.
 *
 * Roadmap: `docs/jarvis-roadmap.md`.
 */

import type {
  AssistantEventHub,
  AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  parsePerceptionEvent,
  PERCEPTION_EVENT_TYPE_PREFIX,
  type PerceptionEvent,
  type PerceptionEventKind,
} from "./perception-event.js";

const log = getLogger("perception-context-buffer");

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface BufferedPerceptionEvent {
  /** When the daemon received the event (not when the producer captured it). */
  readonly receivedAt: Date;
  /** The validated payload. */
  readonly event: PerceptionEvent;
}

export interface ContextBufferOptions {
  /** Maximum entries retained; oldest pruned on overflow. */
  readonly maxEntries?: number;
  /** Per-entry max age in milliseconds; pruned lazily. */
  readonly ttlMs?: number;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

export interface RecentQuery {
  /** Only return entries received within the last N ms. */
  readonly windowMs?: number;
  /** Cap the number of returned entries (most recent first). */
  readonly limit?: number;
  /** Restrict to a specific perception kind. */
  readonly kind?: PerceptionEventKind;
}

/**
 * In-memory ring of perception events. One instance per daemon process.
 *
 * Not thread-safe across workers; the daemon is single-process for this
 * data path.
 */
export class ContextBuffer {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly entries: BufferedPerceptionEvent[] = [];
  private subscription: AssistantEventSubscription | null = null;

  constructor(options: ContextBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
    if (this.maxEntries < 1) {
      throw new RangeError("ContextBuffer.maxEntries must be >= 1");
    }
    if (this.ttlMs < 1) {
      throw new RangeError("ContextBuffer.ttlMs must be >= 1ms");
    }
  }

  /**
   * Subscribe to the hub. Idempotent. Returns the existing subscription if
   * already attached so the caller does not need to track state.
   */
  attach(hub: AssistantEventHub): AssistantEventSubscription {
    if (this.subscription) return this.subscription;
    this.subscription = hub.subscribe({
      type: "process",
      callback: (event) => this.ingest(event),
    });
    return this.subscription;
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /**
   * Validate and store an event if it's a perception event. Non-perception
   * events are silently ignored. Malformed perception events are logged and
   * dropped; we never throw out of an event-pipeline handler.
   */
  ingest(event: unknown): void {
    const type = getEventType(event);
    if (!type || !type.startsWith(`${PERCEPTION_EVENT_TYPE_PREFIX}.`)) return;

    const message = getEventMessage(event);
    if (!message) return;
    const candidate = extractPerceptionPayload(message);

    let parsed;
    try {
      parsed = parsePerceptionEvent(candidate);
    } catch (err) {
      log.warn(
        { err, type },
        "dropping perception event that failed schema validation",
      );
      return;
    }

    const receivedAt = this.now();
    this.entries.push({ receivedAt, event: parsed });
    this.pruneExpired(receivedAt);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Return entries most-recent-first, after applying TTL and the optional
   * `windowMs` / `limit` / `kind` filters.
   */
  recent(query: RecentQuery = {}): BufferedPerceptionEvent[] {
    const now = this.now();
    this.pruneExpired(now);

    const earliest =
      query.windowMs != null ? now.getTime() - query.windowMs : -Infinity;
    const out: BufferedPerceptionEvent[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (!entry) continue;
      if (entry.receivedAt.getTime() < earliest) break;
      if (query.kind && entry.event.payload.kind !== query.kind) continue;
      out.push(entry);
      if (query.limit != null && out.length >= query.limit) break;
    }
    return out;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }

  private pruneExpired(now: Date): void {
    const cutoff = now.getTime() - this.ttlMs;
    while (this.entries.length > 0) {
      const first = this.entries[0];
      if (!first) break;
      if (first.receivedAt.getTime() >= cutoff) break;
      this.entries.shift();
    }
  }
}

/**
 * Read the `message.type` field off an `AssistantEvent`-shaped value without
 * importing the discriminated union (which doesn't include perception types).
 */
function getEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function getEventMessage(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  return message as Record<string, unknown>;
}

/**
 * Pull a `PerceptionEvent`-shaped object out of the AssistantEvent's
 * `message`. We accept either an explicitly-nested `{ perception: ... }`
 * shape or a flattened message where the perception fields sit alongside
 * the outer `type`, so producers can choose either style.
 */
function extractPerceptionPayload(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const nested = message.perception;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return message;
}
