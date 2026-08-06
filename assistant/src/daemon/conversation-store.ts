/**
 * Module-private in-memory conversation store and lifecycle.
 *
 * All active {@link Conversation} instances live here. External code
 * accesses them exclusively through the exported helper functions,
 * decoupling route handlers and IPC callbacks from the DaemonServer
 * class.
 *
 * The {@link getOrCreateConversation} function owns the full
 * creation/reuse lifecycle — provider wiring, rate limiting, system
 * prompt assembly, and DB hydration. Idle eviction lives in
 * `conversation-evictor`.
 */

import { getConfig } from "../config/loader.js";
import {
  ADOPTABLE_CONVERSATION_ID_RE,
  createConversation,
  ensureConversationExists,
  getConversation,
} from "../persistence/conversation-crud.js";
import type { ConversationOrigin } from "../persistence/conversation-types.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import {
  mainAgentResolutionError,
  resolveDefaultProvider,
} from "../providers/connection-resolution.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { listProviders } from "../providers/registry.js";
import { getSubagentManager } from "../subagent/index.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import { Conversation } from "./conversation.js";
import {
  removeFromEvictor,
  touchConversation,
} from "./conversation-evictor.js";
import { resolveInitialSystemPrompt } from "./conversation-initial-prompt.js";
import {
  allConversations,
  clearConversations,
  conversationCount,
  conversationEntries,
  conversationIds,
  deleteConversation,
  findConversation,
  setConversation,
} from "./conversation-registry.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { buildTransportHints } from "./transport-hints.js";

// ── Per-conversation persistent options ────────────────────────────

const conversationOptions = new Map<string, ConversationCreateOptions>();

/**
 * The channel a conversation created here belongs to.
 *
 * A trust context is stamped per inbound message from the gateway verdict,
 * so `sourceChannel` names the channel the message creating this
 * conversation actually arrived on. This is the moment that fact is known,
 * and the caller is the only party that holds it.
 *
 * Returns `undefined` when there is no trust context, which does NOT mean
 * native. `handleSendMessage` materializes a conversation before the route
 * resolves trust, so a Slack or phone send reaches here with no
 * `sourceChannel` yet. Assuming native there would stamp a remote
 * conversation as the guardian's own, and nothing could repair it:
 * `setConversationOriginChannelIfUnset` only writes over NULL, and
 * `recoverRestingTrustContext` grants INTERNAL_GUARDIAN_TRUST_CONTEXT to the
 * native channel on every later wake and boot-resume.
 *
 * `transport.channelId` is not a substitute. It is the external Slack
 * conversation id, not a {@link ChannelId}.
 *
 * So this states the origin only where it is genuinely known, and leaves the
 * rest to attribution exactly as before. The remaining callers get their
 * origin when they are migrated with real knowledge of it, not by guessing
 * here.
 */
function originFromStoredOptions(
  storedOptions: ConversationCreateOptions | undefined,
): ConversationOrigin | undefined {
  return storedOptions?.trustContext?.sourceChannel;
}

/**
 * Drops the transport fields that describe what the client had on screen for a
 * single message rather than for the conversation as a whole.
 *
 * `conversationOptions` is a durable map: a rebuilt conversation (evicted or
 * gone stale) re-applies whatever transport was stored the last time anyone
 * touched it. View state must not survive that, or a scheduled wake hours
 * later would resurrect an app the user has since closed and assert it is on
 * screen. The current call still applies the full transport to the live
 * conversation, so only the persisted copy is trimmed.
 */
export function withoutTurnScopedTransport(
  options: ConversationCreateOptions,
): ConversationCreateOptions {
  const transport = options.transport;
  if (!transport || transport.visibleAppId === undefined) {
    return options;
  }
  return {
    ...options,
    transport: { ...transport, visibleAppId: undefined },
  };
}

export function mergeConversationOptions(
  conversationId: string,
  patch: Partial<ConversationCreateOptions>,
): void {
  conversationOptions.set(conversationId, {
    ...conversationOptions.get(conversationId),
    ...patch,
  });
}

function deleteConversationOptions(conversationId: string): void {
  conversationOptions.delete(conversationId);
}

function clearConversationOptions(): void {
  conversationOptions.clear();
}

// ── Conversation lifecycle ─────────────────────────────────────────

/** Dedup guard: in-flight creation promises keyed by conversation ID. */
const conversationCreating = new Map<string, Promise<Conversation>>();

function applyTransportMetadata(
  conversation: Conversation,
  options: ConversationCreateOptions | undefined,
): void {
  const transport = options?.transport;
  if (!transport) {
    return;
  }
  conversation.setTransportHints(buildTransportHints(transport));
  conversation.applyHostEnvFromTransport(transport);
  conversation.applyClientTimezoneFromTransport(transport);
  conversation.applyClientOsFromTransport(transport);
  conversation.applyVisibleAppFromTransport(transport);
}

/**
 * Get or create an active conversation by ID.
 *
 * Handles provider setup, rate limiting, system prompt, memory policy,
 * and conversation hydration.
 */
export async function getOrCreateConversation(
  conversationId: string,
  options?: ConversationCreateOptions,
): Promise<Conversation> {
  let conversation = findConversation(conversationId);
  const sendToClient = () => {};

  // `taskRunId` and `ephemeral` are per-call scopes, not durable conversation
  // metadata, so they are stripped before the remaining options are merged
  // into the persisted `conversationOptions` map.
  const {
    taskRunId: _taskRunId,
    ephemeral,
    ...persistentOptions
  } = options ?? {};
  if (Object.values(persistentOptions).some((v) => v !== undefined)) {
    mergeConversationOptions(
      conversationId,
      withoutTurnScopedTransport(persistentOptions),
    );
  }

  // A stale conversation is rebuilt only once it is genuinely idle. Queued
  // messages live in memory on the instance being disposed, and the queue
  // drains via an async dispatch after the current turn releases, so
  // `isProcessing()` can read false while a queued turn is still pending:
  // rebuilding in that gap would silently drop those messages. The conversation
  // stays stale and is rebuilt on a later call.
  if (
    !conversation ||
    (conversation.isStale() &&
      !conversation.isProcessing() &&
      !conversation.hasQueuedMessages())
  ) {
    if (conversation) {
      // Stale rebuild: the conversation id lives on, so abort in-flight
      // children but keep terminal subagent results readable for the
      // retention window.
      getSubagentManager().abortAllForParent(conversationId);
      conversation.dispose();
    }

    const pending = conversationCreating.get(conversationId);
    if (pending) {
      conversation = await pending;
      return conversation;
    }

    const storedOptions = conversationOptions.get(conversationId);

    const createPromise = (async () => {
      const config = getConfig();
      // Connection-aware default-provider resolution. Throws
      // `ConnectionResolutionError` when the default profile's
      // `provider_connection` is unset / unknown / mismatched (config
      // bugs). Returns null on soft credential failures (missing
      // credential, platform auth unavailable).
      const baseProvider = await resolveDefaultProvider(config);
      if (!baseProvider) {
        throw await mainAgentResolutionError(config.llm, listProviders());
      }
      // Per-call `callSite` routing layered on top, with connection-awareness
      // for alternate profiles (matches the canonical dispatch path).
      let provider = wrapWithCallSiteRouting(baseProvider, config);
      const { rateLimit } = config;
      if (rateLimit.maxRequestsPerMinute > 0) {
        provider = new RateLimitProvider(
          provider,
          rateLimit,
          getSubagentManager().sharedRequestTimestamps,
        );
      }
      const workingDir = getSandboxWorkingDir();

      const systemPrompt = await resolveInitialSystemPrompt(storedOptions);
      const maxTokens = storedOptions?.maxResponseTokens;

      const newConversation = new Conversation(
        conversationId,
        provider,
        systemPrompt,
        sendToClient,
        workingDir,
        {
          maxTokens,
          speedOverride: storedOptions?.speed,
          modelOverride: storedOptions?.modelOverride,
        },
      );
      newConversation.updateClient(sendToClient, true);

      // Ensure the conversations row exists before hydrating from DB.
      // `getOrCreateConversation` builds the in-memory Conversation, but
      // the persisted row is what `loadFromDb` reads for conversationType,
      // source, and other metadata. If the row doesn't exist yet (brand-new
      // conversation), create it now so hydration caches the right fields.
      //
      // When `conversationType` is provided (e.g. "background" for
      // plugin-driven conversations), create the row with that type so it
      // is hidden from the sidebar. The ID is validated against the same
      // pattern as `ensureConversationExists` to prevent path traversal.
      // Otherwise use `ensureConversationExists` directly, which validates
      // and creates a standard row.
      //
      // Ephemeral calls skip row creation entirely: their contract persists
      // nothing, so the in-memory Conversation hydrates from whatever rows
      // already exist without leaking a sidebar-visible row. `loadFromDb`
      // tolerates a missing row.
      if (!ephemeral && !getConversation(conversationId)) {
        if (storedOptions?.conversationType) {
          if (!ADOPTABLE_CONVERSATION_ID_RE.test(conversationId)) {
            throw new Error(
              `Refusing to adopt unsafe conversation id: ${JSON.stringify(conversationId)}`,
            );
          }
          createConversation({
            id: conversationId,
            conversationType: storedOptions.conversationType,
            origin: originFromStoredOptions(storedOptions),
          });
        } else {
          ensureConversationExists(
            conversationId,
            originFromStoredOptions(storedOptions),
          );
        }
      }

      await newConversation.loadFromDb();
      if (storedOptions?.assistantId) {
        newConversation.setAssistantId(storedOptions.assistantId);
      }
      if (storedOptions?.trustContext) {
        newConversation.setTrustContext(storedOptions.trustContext);
      }
      if (storedOptions?.authContext) {
        newConversation.setAuthContext(storedOptions.authContext);
      }
      if (storedOptions?.trustContext || storedOptions?.authContext) {
        await newConversation.ensureActorScopedHistory();
      }
      applyTransportMetadata(newConversation, storedOptions);
      // The stored transport is stripped of view state, so a rebuild driven by
      // a live send takes the app on screen from THIS call. A rebuild with no
      // inbound transport (a scheduled wake, a background follow-up) correctly
      // leaves it unset rather than inheriting whatever was open last time.
      if (options?.transport) {
        newConversation.applyVisibleAppFromTransport(options.transport);
      }
      setConversation(conversationId, newConversation);
      return newConversation;
    })();

    conversationCreating.set(conversationId, createPromise);
    try {
      conversation = await createPromise;
    } finally {
      conversationCreating.delete(conversationId);
    }
    touchConversation(conversationId);
  } else {
    if (!conversation.isProcessing()) {
      applyTransportMetadata(conversation, options);
      if (options?.trustContext !== undefined) {
        conversation.setTrustContext(options.trustContext);
      }
    }
    touchConversation(conversationId);
  }
  return conversation;
}

/**
 * Abort, dispose, and remove a single in-memory conversation.
 * Use before deleting the DB row so the agent loop can't write to a
 * deleted conversation and trip FK constraints.
 *
 * `keepSubagentRecords` leaves the children's durable rows behind for the
 * caller to delete once its own destructive work has committed, see
 * `SubagentManager.disposeAllForParent`.
 */
export function destroyActiveConversation(
  conversationId: string,
  opts?: { keepSubagentRecords?: boolean },
): void {
  // Subagent teardown is keyed by parent id, not the live instance — an
  // evicted parent still retains its terminal children, and deleting the
  // conversation must take their records with it.
  getSubagentManager().disposeAllForParent(conversationId, undefined, {
    keepRecords: opts?.keepSubagentRecords === true,
  });
  const conversation = findConversation(conversationId);
  if (!conversation) {
    return;
  }
  removeFromEvictor(conversationId);
  conversation.dispose();
  deleteConversation(conversationId);
  deleteConversationOptions(conversationId);
}

/**
 * Dispose all in-memory conversations and clear the store during daemon
 * shutdown. Subagent teardown and evictor stop are driven separately by the
 * shutdown sequence, so this only releases the conversation instances and
 * resets the registry.
 */
export function stopConversations(): void {
  for (const conversation of allConversations()) {
    conversation.dispose();
  }
  clearConversations();
}

/**
 * Dispose all in-memory conversations, clear the store, and remove
 * from the evictor. Returns the count of conversations that were cleared.
 */
export function clearAllActiveConversations(): number {
  const count = conversationCount();
  // Tear down subagents across ALL parents, not just the in-memory ones: an
  // evicted parent still retains its terminal children, and clear-all must
  // reach them. Pass `keepRecords` so the rows themselves are deleted by the
  // following `clearAll()` DB wipe in retry-safe order (conversations first,
  // then subagents); an eager delete here would lose them if that wipe throws.
  getSubagentManager().disposeAllForAllParents({ keepRecords: true });
  for (const id of conversationIds()) {
    removeFromEvictor(id);
  }
  for (const conversation of allConversations()) {
    conversation.dispose();
  }
  clearConversations();
  clearConversationOptions();
  return count;
}

/**
 * Evict in-memory conversations after a config/prompt/skills reload so the next
 * turn rebuilds them against the new config. Idle conversations are disposed and
 * dropped; busy ones are marked stale so they're rebuilt once their current turn
 * finishes. Also used when provider credentials change.
 */
export function evictConversationsForReload(): void {
  const subagentManager = getSubagentManager();
  for (const [id, conversation] of conversationEntries()) {
    // A conversation with queued messages is not idle: the queue drains via an
    // async dispatch after the current turn releases, so `isProcessing()` can
    // read false while a queued turn is still pending. Disposing in that gap
    // would silently drop the queued messages, so mark it stale instead and
    // let it rebuild once the queue has run.
    if (!conversation.isProcessing() && !conversation.hasQueuedMessages()) {
      subagentManager.abortAllForParent(id);
      conversation.dispose();
      deleteConversation(id);
      removeFromEvictor(id);
    } else {
      conversation.markStale();
    }
  }
}
