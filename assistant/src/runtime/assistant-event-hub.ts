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
import { emitFeedEvent } from "../home/emit-feed-event.js";
import { rewriteCommandPreview } from "../home/rewrite-command-preview.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { summarizeToolInput } from "../tools/tool-input-summary.js";
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
   * **Client deduplication:** When a client subscriber is registered with a
   * `clientId` that already exists, all stale entries for that clientId are
   * disposed first. This prevents subscriber stacking when clients reconnect
   * (e.g. Chrome extension reload, SSE token refresh) before the old
   * connection's abort signal fires.
   *
   * When the subscriber cap (`maxSubscribers`) has been reached, the **oldest**
   * subscriber is evicted to make room: its `onEvict` callback is invoked (so
   * it can close its SSE stream) and its entry is removed from the hub.
   */
  subscribe(subscriber: SubscriberInput): AssistantEventSubscription {
    // Deduplicate: dispose stale subscribers for the same clientId.
    if (subscriber.type === "client") {
      const stale: SubscriberEntry[] = [];
      for (const existing of this.subscribers) {
        if (
          existing.type === "client" &&
          existing.clientId === subscriber.clientId
        ) {
          stale.push(existing);
        }
      }
      for (const entry of stale) {
        entry.active = false;
        this.subscribers.delete(entry);
        try {
          entry.onEvict();
        } catch {
          /* ignore eviction callback errors */
        }
      }
      if (stale.length > 0) {
        log.info(
          { clientId: subscriber.clientId, count: stale.length },
          "disposed stale subscribers for reconnecting client",
        );
      }
    }

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
    const now = new Date();
    for (const entry of this.subscribers) {
      if (
        entry.active &&
        entry.type === "client" &&
        entry.clientId === clientId
      ) {
        entry.lastActiveAt = now;
      }
    }
  }

  /**
   * Force-disconnect a client by disposing all subscribers for the given
   * `clientId`. Returns the number of disposed entries.
   *
   * Used by `assistant clients disconnect <clientId>` to forcibly remove
   * stale or unwanted client connections.
   */
  disposeClient(clientId: string): number {
    const targets: SubscriberEntry[] = [];
    for (const entry of this.subscribers) {
      if (
        entry.type === "client" &&
        entry.clientId === clientId
      ) {
        targets.push(entry);
      }
    }
    for (const entry of targets) {
      entry.active = false;
      this.subscribers.delete(entry);
      try {
        entry.onEvict();
      } catch {
        /* ignore eviction callback errors */
      }
    }
    if (targets.length > 0) {
      log.info(
        { clientId, count: targets.length },
        "force-disposed client subscribers",
      );
    }
    return targets.length;
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
  options?: { targetCapability?: HostProxyCapability },
): void {
  const resolvedConversationId = conversationId ?? extractConversationId(msg);

  // Register pending interactions so approval/host prompts are tracked
  // regardless of which path triggered the broadcast.
  if (resolvedConversationId) {
    registerPendingInteraction(msg, resolvedConversationId);
  }

  // Emit feed events for confirmation requests (tool approval prompts).
  if (msg.type === "confirmation_request" && resolvedConversationId) {
    void emitConfirmationFeedEvent(msg, resolvedConversationId);
  }

  // `conversation_list_invalidated` is a list-level system event — publish
  // it unscoped so every subscriber refreshes its sidebar.
  const scopedConversationId =
    msg.type === "conversation_list_invalidated"
      ? undefined
      : resolvedConversationId;
  const event = buildAssistantEvent(msg, scopedConversationId);
  _hubChain = _hubChain
    .then(() => assistantEventHub.publish(event, options))
    .then(() => {
      // When a conversation title changes, also broadcast an unscoped
      // `conversation_list_invalidated` so every connected client's sidebar
      // refreshes — not just the client viewing this conversation.
      if (msg.type === "conversation_title_updated") {
        return assistantEventHub
          .publish(
            buildAssistantEvent({
              type: "conversation_list_invalidated",
              reason: "renamed",
            }),
          )
          .catch((err: unknown) => {
            log.warn(
              { err },
              "Failed to publish conversation_list_invalidated after title update",
            );
          });
      }
    })
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

// ── Feed events for confirmation requests ─────────────────────────────────────

/**
 * Emit a feed event when a confirmation request (tool approval prompt) is
 * broadcast. Emits immediately with a technical preview, then rewrites
 * into prose in the background and updates the feed item.
 */
async function emitConfirmationFeedEvent(
  msg: ServerMessage & { type: "confirmation_request" },
  conversationId: string,
): Promise<void> {
  try {
    const inputRecord = msg.input as Record<string, unknown>;
    const commandPreview =
      redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) || undefined;
    const technicalTitle = commandPreview
      ? `Requesting permission: ${commandPreview}`
      : `Requesting approval to use ${msg.toolName}.`;
    const dedupKey = `tool-approval:${msg.requestId}`;

    await emitFeedEvent({
      source: "assistant",
      title: technicalTitle,
      summary: technicalTitle,
      dedupKey,
      urgency: msg.riskLevel === "high" ? "high" : "medium",
      conversationId,
      detailPanel: { kind: "toolPermission" },
    });

    // Background: rewrite into prose and update the feed item.
    if (commandPreview) {
      const prose = await rewriteCommandPreview(msg.toolName, commandPreview);
      if (prose) {
        const proseTitle = `Requesting permission: ${prose}`;
        await emitFeedEvent({
          source: "assistant",
          title: proseTitle,
          summary: proseTitle,
          dedupKey,
          urgency: msg.riskLevel === "high" ? "high" : "medium",
          conversationId,
          detailPanel: { kind: "toolPermission" },
        });
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to emit confirmation feed event from broadcast");
  }
}
