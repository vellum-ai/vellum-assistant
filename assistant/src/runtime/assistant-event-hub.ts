/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by the daemon send paths
 * and the SSE route.
 *
 * Subscribers are typed via a discriminated union:
 *   - **ClientEntry** — an SSE-connected client (macos, chrome-extension, …)
 *     with identity, capabilities, and timestamps.
 *   - **ProcessEntry** — an in-process consumer (future: file-append logger).
 *
 * Client-oriented queries (list, find-by-capability) are methods on the hub.
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { getLogger } from "../util/logger.js";
import type { AssistantEvent } from "./assistant-event.js";
import { buildAssistantEvent } from "./assistant-event.js";
import * as pendingInteractions from "./pending-interactions.js";

const log = getLogger("assistant-event-hub");

// ── Types ─────────────────────────────────────────────────────────────────────

/** Filter that determines which events a subscriber receives. */
export type AssistantEventFilter = {
  /** When set, restrict delivery to events for this conversation. */
  conversationId?: string;
};

export type AssistantEventCallback = (
  event: AssistantEvent,
) => void | Promise<void>;

/** Opaque handle returned by `subscribe`. Call `dispose()` to remove the subscription. */
export interface AssistantEventSubscription {
  dispose(): void;
  /** True until `dispose()` has been called. */
  readonly active: boolean;
}

// ── Subscriber entries (discriminated union) ─────────────────────────────────

interface BaseSubscriberEntry {
  filter: AssistantEventFilter;
  callback: AssistantEventCallback;
  active: boolean;
  onEvict: () => void;
  connectedAt: Date;
  lastActiveAt: Date;
}

export interface ClientEntry extends BaseSubscriberEntry {
  type: "client";
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
}

export interface ProcessEntry extends BaseSubscriberEntry {
  type: "process";
}

export type SubscriberEntry = ClientEntry | ProcessEntry;

/** Distributive Omit that preserves union discrimination. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Input shape for `subscribe()` — hub fills `active`, `connectedAt`, `lastActiveAt` and defaults `filter`/`onEvict`. */
export type SubscriberInput = DistributiveOmit<
  SubscriberEntry,
  "active" | "connectedAt" | "lastActiveAt" | "filter" | "onEvict"
> & {
  filter?: AssistantEventFilter;
  onEvict?: () => void;
};

// ── Hub ───────────────────────────────────────────────────────────────────────

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level:
 *   - `conversationId`: scoped events match subscribers with same conversationId
 *     or no conversationId filter (broadcast to all).
 *   - `targetCapability` (on publish): targeted events only reach subscribers
 *     whose capabilities include the target. Untargeted events fan out to all.
 *
 * Client connections register as subscribers with metadata and are queryable
 * via `listClients()`, `getMostRecentClientByCapability()`, etc.
 */
export class AssistantEventHub {
  private readonly subscribers = new Set<SubscriberEntry>();
  private readonly maxSubscribers: number;

  constructor(options?: { maxSubscribers?: number }) {
    this.maxSubscribers = options?.maxSubscribers ?? Infinity;
  }

  /**
   * Register a subscriber that will be called for each matching event.
   *
   * When the subscriber cap (`maxSubscribers`) has been reached, the **oldest**
   * subscriber is evicted to make room: its `onEvict` callback is invoked (so
   * it can close its SSE stream) and its entry is removed from the hub.
   */
  subscribe(subscriber: SubscriberInput): AssistantEventSubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      const [oldest] = this.subscribers;
      if (!oldest) {
        throw new RangeError(
          `AssistantEventHub: subscriber cap reached (${this.maxSubscribers})`,
        );
      }
      oldest.active = false;
      this.subscribers.delete(oldest);
      try {
        oldest.onEvict();
      } catch {
        /* ignore eviction callback errors */
      }
    }

    const now = new Date();
    const entry: SubscriberEntry = {
      ...subscriber,
      filter: subscriber.filter ?? {},
      onEvict: subscriber.onEvict ?? (() => {}),
      active: true,
      connectedAt: now,
      lastActiveAt: now,
    } as SubscriberEntry;

    if (entry.type === "client") {
      log.info(
        {
          clientId: entry.clientId,
          interfaceId: entry.interfaceId,
          capabilities: entry.capabilities,
        },
        "subscriber registered (client)",
      );
    } else {
      log.info("subscriber registered (process)");
    }

    this.subscribers.add(entry);

    return {
      dispose: () => {
        if (entry.active) {
          entry.active = false;
          this.subscribers.delete(entry);
          if (entry.type === "client") {
            log.info(
              {
                clientId: entry.clientId,
                interfaceId: entry.interfaceId,
              },
              "subscriber unregistered (client)",
            );
          } else {
            log.info("subscriber unregistered (process)");
          }
        }
      },
      get active() {
        return entry.active;
      },
    };
  }

  /**
   * Publish an event to all matching subscribers.
   *
   * Matching rules:
   * - if `filter.conversationId` is set, `event.conversationId` must equal it
   * - if `targetCapability` is set, only subscribers whose capabilities include
   *   it receive the event; untargeted events go to all
   *
   * Fanout is isolated: a throwing or rejecting subscriber does not abort
   * delivery to remaining subscribers.
   */
  async publish(
    event: AssistantEvent,
    options?: { targetCapability?: HostProxyCapability },
  ): Promise<void> {
    if (event.conversationId) {
      try {
        appendEventToStream(event.conversationId, event);
      } catch {
        // Best-effort; file I/O failures must not block subscriber fanout.
      }
    }

    const targetCapability = options?.targetCapability;
    const snapshot = Array.from(this.subscribers);
    const errors: unknown[] = [];

    for (const entry of snapshot) {
      if (!entry.active) continue;

      // Conversation scoping: scoped events skip subscribers filtering on a
      // different conversation.
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      )
        continue;

      // Capability targeting: targeted events only go to subscribers that
      // declare the required capability.
      if (targetCapability != null) {
        if (
          entry.type !== "client" ||
          !entry.capabilities.includes(targetCapability)
        )
          continue;
      }

      try {
        await entry.callback(event);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "One or more assistant-event subscribers threw",
      );
    }
  }

  /**
   * Returns true when at least one active subscriber would receive the given
   * event based on the same conversation matching rules as publish().
   */
  hasSubscribersForEvent(
    event: Pick<AssistantEvent, "conversationId">,
  ): boolean {
    for (const entry of this.subscribers) {
      if (!entry.active) continue;
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  // ── Client queries ──────────────────────────────────────────────────────────

  private clientEntries(): ClientEntry[] {
    const clients: ClientEntry[] = [];
    for (const entry of this.subscribers) {
      if (entry.active && entry.type === "client") {
        clients.push(entry);
      }
    }
    return clients.sort(
      (a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime(),
    );
  }

  /**
   * Return all active client subscribers, sorted by `lastActiveAt` descending.
   */
  listClients(): ClientEntry[] {
    return this.clientEntries();
  }

  /**
   * Return all client subscribers that support the given capability,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByCapability(capability: HostProxyCapability): ClientEntry[] {
    return this.clientEntries().filter((c) =>
      c.capabilities.includes(capability),
    );
  }

  /**
   * Return the most recently active client that supports the given
   * capability, or `undefined` if none exists.
   */
  getMostRecentClientByCapability(
    capability: HostProxyCapability,
  ): ClientEntry | undefined {
    return this.listClientsByCapability(capability)[0];
  }

  /**
   * Return all client subscribers with the given interface type,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByInterface(interfaceId: InterfaceId): ClientEntry[] {
    return this.clientEntries().filter((c) => c.interfaceId === interfaceId);
  }

  /**
   * Touch a client subscriber — update `lastActiveAt`. Used by heartbeat.
   */
  touchClient(clientId: string): void {
    for (const entry of this.subscribers) {
      if (
        entry.active &&
        entry.type === "client" &&
        entry.clientId === clientId
      ) {
        entry.lastActiveAt = new Date();
        return;
      }
    }
  }

  /** Number of currently active subscribers (useful for tests and caps). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Returns true if the hub can accept a subscriber without evicting anyone. */
  hasCapacity(): boolean {
    return this.subscribers.size < this.maxSubscribers;
  }
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Singleton hub shared across the entire runtime process.
 *
 * Import and use this in daemon send paths and the SSE route.
 */
export const assistantEventHub = new AssistantEventHub({ maxSubscribers: 100 });

// ── Convenience: ServerMessage → AssistantEvent publish ───────────────────────

/**
 * Promise chain that serializes publishes so subscribers always observe
 * events in send order.
 */
let _hubChain = Promise.resolve();

/**
 * Wraps a `ServerMessage` in an `AssistantEvent` envelope and publishes it
 * to the process-level hub.
 *
 * When `conversationId` is omitted, it is auto-extracted from the message
 * payload (if present).
 *
 * This is the primary entrypoint for emitting events — handlers, routes, and
 * services should call this directly instead of threading a broadcast callback.
 */
export function broadcastMessage(
  msg: ServerMessage,
  conversationId?: string,
): void {
  const resolvedConversationId = conversationId ?? extractConversationId(msg);

  // Register pending interactions so approval/host prompts are tracked
  // regardless of which path triggered the broadcast.
  if (resolvedConversationId) {
    registerPendingInteraction(msg, resolvedConversationId);
  }

  const event = buildAssistantEvent(msg, resolvedConversationId);
  _hubChain = _hubChain
    .then(() => assistantEventHub.publish(event))
    .catch((err: unknown) => {
      log.warn({ err }, "assistant-events hub subscriber threw during publish");
    });
}

function extractConversationId(msg: ServerMessage): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ("conversationId" in msg && typeof record.conversationId === "string") {
    return record.conversationId as string;
  }
  return undefined;
}

// ── Pending interaction registration ──────────────────────────────────────────

function resolveCanonicalRequestSourceType(
  sourceChannel: string,
): "desktop" | "channel" | "voice" {
  if (sourceChannel === "phone") return "voice";
  if (sourceChannel === "vellum") return "desktop";
  return "channel";
}

/**
 * Register pending interactions for request-type messages so approval and
 * host prompts are tracked regardless of which code path broadcasts them.
 *
 * Heavy dependencies (conversation-store, canonical-guardian-store, etc.) are
 * imported lazily so that loading this module during tests doesn't trigger
 * config/data-dir side effects.
 */
function registerPendingInteraction(
  msg: ServerMessage,
  conversationId: string,
): void {
  if (msg.type === "confirmation_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "confirmation",
      confirmationDetails: {
        toolName: msg.toolName,
        input: msg.input,
        riskLevel: msg.riskLevel,
        executionTarget: msg.executionTarget,
        allowlistOptions: msg.allowlistOptions,
        scopeOptions: msg.scopeOptions,
        persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
      },
    });

    // Create canonical guardian request asynchronously — heavy deps are
    // imported lazily to avoid pulling in conversation-store (and
    // transitively config/loader → ensureDataDir) at module-load time.
    void createCanonicalRequestForConfirmation(msg, conversationId);
  } else if (msg.type === "secret_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "secret",
    });
  } else if (msg.type === "host_bash_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "host_bash",
    });
  } else if (msg.type === "host_browser_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "host_browser",
    });
  } else if (msg.type === "host_file_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "host_file",
    });
  } else if (msg.type === "host_cu_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "host_cu",
    });
  } else if (msg.type === "host_transfer_request") {
    pendingInteractions.register(msg.requestId, {
      conversationId,
      kind: "host_transfer",
    });
  }
}

/**
 * Lazily load heavy dependencies and create a canonical guardian request +
 * bridge for a confirmation_request message. Runs fire-and-forget from
 * registerPendingInteraction.
 */
async function createCanonicalRequestForConfirmation(
  msg: ServerMessage & { type: "confirmation_request" },
  conversationId: string,
): Promise<void> {
  try {
    const [
      { findConversation },
      { createCanonicalGuardianRequest, generateCanonicalRequestCode },
      { redactSecrets },
      { summarizeToolInput },
      { DAEMON_INTERNAL_ASSISTANT_ID },
      { bridgeConfirmationRequestToGuardian },
    ] = await Promise.all([
      import("../daemon/conversation-store.js"),
      import("../memory/canonical-guardian-store.js"),
      import("../security/secret-scanner.js"),
      import("../tools/tool-input-summary.js"),
      import("./assistant-scope.js"),
      import("./confirmation-request-guardian-bridge.js"),
    ]);

    const conversation = findConversation(conversationId);
    const trustContext = conversation?.trustContext;
    const sourceChannel = trustContext?.sourceChannel ?? "vellum";
    const inputRecord = msg.input as Record<string, unknown>;
    const activityRaw =
      (typeof inputRecord.activity === "string"
        ? inputRecord.activity
        : undefined) ??
      (typeof inputRecord.reason === "string" ? inputRecord.reason : undefined);
    const canonicalRequest = createCanonicalGuardianRequest({
      id: msg.requestId,
      kind: "tool_approval",
      sourceType: resolveCanonicalRequestSourceType(sourceChannel),
      sourceChannel,
      conversationId,
      requesterExternalUserId: trustContext?.requesterExternalUserId,
      requesterChatId: trustContext?.requesterChatId,
      guardianExternalUserId: trustContext?.guardianExternalUserId,
      guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
      toolName: msg.toolName,
      commandPreview:
        redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) ||
        undefined,
      riskLevel: msg.riskLevel,
      activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
      executionTarget: msg.executionTarget,
      status: "pending",
      requestCode: generateCanonicalRequestCode(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    if (trustContext && conversation) {
      bridgeConfirmationRequestToGuardian({
        canonicalRequest,
        trustContext,
        conversationId,
        toolName: msg.toolName,
        assistantId: conversation.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      });
    }
  } catch (err) {
    log.debug(
      { err, conversationId },
      "Failed to create canonical request from broadcast",
    );
  }
}
