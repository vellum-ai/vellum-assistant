/**
 * Module-private in-memory conversation store and lifecycle.
 *
 * All active {@link Conversation} instances live here. External code
 * accesses them exclusively through the exported helper functions,
 * decoupling route handlers and IPC callbacks from the DaemonServer
 * class.
 *
 * {@link getOrCreateConversation} and {@link getConversationIfExists} share
 * one body that owns the full creation/reuse lifecycle: provider wiring, rate
 * limiting, system prompt assembly, and DB hydration. Idle eviction lives in
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
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
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

/** Dedup guard: in-flight acquisitions keyed by conversation ID. */
const conversationCreating = new Map<string, Promise<Conversation | null>>();

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
 *
 * The in-memory Conversation snapshots the tool registry at construction.
 * An empty snapshot is an empty tool list on the wire for the life of the
 * instance, so the create path initializes the registry before that
 * constructor runs. A hit in `findConversation` already has its snapshot.
 * `initializeTools` is idempotent: a process that already initialized at
 * boot awaits the settled promise.
 */
export async function getOrCreateConversation(
  conversationId: string,
  options?: ConversationCreateOptions,
): Promise<Conversation> {
  // Null is the non-creating acquire's answer and nobody else's.
  return (await acquireConversation(conversationId, options, true))!;
}

/**
 * Acquire an active conversation, or null when the one asked about is gone.
 *
 * For a caller whose work is only meaningful inside a conversation that still
 * exists: a queued job whose conversation can be deleted between the moment it
 * was accepted and the moment it runs. {@link getOrCreateConversation} would
 * write the row back for it, which resurrects a conversation the user deleted.
 *
 * The question it answers is about one incarnation, not about an id. A row
 * deleted and written back under the same id is a different conversation, and
 * this reports it as gone rather than persisting into a stranger that inherited
 * the name.
 *
 * Distinct from the two cheaper reads it sits above:
 * `findConversation` returns only an instance already in memory, and the
 * persistence layer's `getConversation` returns only the row. This builds and
 * hydrates the instance the way the creating acquire does, and answers null
 * exactly where that one would insert.
 */
export function getConversationIfExists(
  conversationId: string,
  options?: ConversationCreateOptions,
): Promise<Conversation | null> {
  return acquireConversation(conversationId, options, false);
}

/**
 * Whether the conversation is still the incarnation the caller was asked about.
 *
 * `created_at` is stamped at insert and nothing else rewrites it, so a row
 * deleted and written back under the same id carries a different one.
 * `createConversation` issues that stamp monotonically per process, which is
 * what makes the two distinguishable even when they land in the same
 * millisecond. Bare existence cannot answer this: a caller sharing flight with
 * a creating acquire can find a row that acquire wrote moments ago and read it
 * as the one it was asked about, and so can one that held an instance across a
 * wait.
 *
 * A conversation restored from its on-disk view (the recovery migration, the
 * `db repair` backfill) is written back with the stamp its meta file records,
 * so it answers as the incarnation it is rather than as a new one. Both
 * restores skip an id whose row is present, so neither can displace a live
 * conversation this way.
 *
 * Exported for callers that keep working after their acquire returns: holding
 * the instance says nothing about the row still being the one behind it.
 */
export function isSameIncarnation(
  conversationId: string,
  createdAt: number | null,
): boolean {
  return (
    createdAt !== null &&
    getConversation(conversationId)?.createdAt === createdAt
  );
}

/**
 * The body both acquires share. `createIfMissing` decides one thing: whether a
 * missing row is written or reported.
 */
async function acquireConversation(
  conversationId: string,
  options: ConversationCreateOptions | undefined,
  createIfMissing: boolean,
): Promise<Conversation | null> {
  // A caller that will not create wants nothing to do with a conversation
  // whose row is gone, resident instance or not. Also spares an already-gone
  // conversation the provider and tool setup below. The row it finds is the
  // incarnation every later acceptance point below answers for.
  let incarnation: number | null = null;
  if (!createIfMissing) {
    incarnation = getConversation(conversationId)?.createdAt ?? null;
    if (incarnation === null) {
      return null;
    }
  }

  let conversation = findConversation(conversationId);

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
  // rebuilding in that gap would silently drop those messages. In-flight
  // subagents are the same: the parent reads idle between its own tool calls
  // while children still run, and rebuilding would abort them. The
  // conversation stays stale and is rebuilt on a later call.
  if (
    !conversation ||
    (conversation.isStale() && !conversation.hasInFlightWork())
  ) {
    if (conversation) {
      // Stale rebuild: the conversation id lives on, so abort any children
      // that raced into flight after the idle check and keep terminal
      // subagent results readable for the retention window.
      getSubagentManager().abortAllForParent(conversationId);
      conversation.dispose();
    }

    // Joining is a loop rather than a single look because a flight can decline
    // to create, and a caller that was asked to create must then re-consult
    // the map instead of building unconditionally: two creating callers that
    // fell through together would each build an instance for one id, the
    // second overwriting the first in the registry and leaving the first to
    // run outside the shared processing and queue state. A non-creating caller
    // re-consults for the mirrored reason: a flight that declined answered for
    // the incarnation IT was asked about, which a delete and recreate can have
    // made a different one from this caller's.
    //
    // It terminates. The owner of a flight attaches its own continuation in
    // the same synchronous run that publishes the flight, so its `finally`
    // has already removed the entry by the time any joiner resumes, and a
    // joiner therefore never re-joins the flight it just awaited. What it
    // finds instead is a newer flight or nothing, and a creating flight only
    // ever resolves non-null, so joining one returns. A non-creating caller
    // passes again only while the row it was asked about is still there, so
    // the delete that a declining flight reports ends its loop as well.
    for (;;) {
      const pending = conversationCreating.get(conversationId);
      if (!pending) {
        break;
      }
      const joined = await pending;
      if (!createIfMissing) {
        // A non-creating acquire answers for the incarnation it was asked
        // about, never for what an acquire it happened to share flight with
        // decided to write. The shared flight can belong to a creating caller,
        // whose own contract is to build the conversation whatever became of
        // the row, and a delete during that caller's setup is answered by
        // writing a fresh row under the same id. Present is therefore not the
        // question: that row is a different conversation, and this caller was
        // never asked to persist into it.
        if (joined) {
          return isSameIncarnation(conversationId, incarnation) ? joined : null;
        }
        // A declining flight reports its own incarnation gone, which says
        // nothing about a later one this caller may hold. Taking that null
        // would refuse work the id can still accept, so this reconsults, and
        // only its own row being gone ends it.
        if (!isSameIncarnation(conversationId, incarnation)) {
          return null;
        }
        continue;
      }
      if (joined) {
        return joined;
      }
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

      const { initializeTools } = await import("../tools/registry.js");
      await initializeTools();

      // Provider resolution, the system prompt, and tool setup all await, and
      // a delete can land in any of them. This is the last instant before the
      // row insert below and nothing between the two awaits, so a non-creating
      // acquire that finds its incarnation gone here never writes it back.
      if (!createIfMissing && !isSameIncarnation(conversationId, incarnation)) {
        return null;
      }

      const newConversation = new Conversation(
        conversationId,
        provider,
        systemPrompt,
        // Top-level conversations deliver to the SSE hub for their whole life,
        // so every subscribed client sees every event with no per-turn wiring.
        broadcastMessage,
        workingDir,
        {
          maxTokens,
          speedOverride: storedOptions?.speed,
          modelOverride: storedOptions?.modelOverride,
        },
      );
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
      // Hydration awaits, so a delete can land between the check that let this
      // build and the registry write. Registering then leaves an active
      // conversation with no row behind it, which later session work finds and
      // reuses. The creating path keeps its own window: it cannot answer null,
      // and a caller that was asked to build owns what it built.
      if (!createIfMissing && !isSameIncarnation(conversationId, incarnation)) {
        newConversation.dispose();
        return null;
      }
      setConversation(conversationId, newConversation);
      return newConversation;
    })();

    conversationCreating.set(conversationId, createPromise);
    let acquired: Conversation | null;
    try {
      acquired = await createPromise;
    } finally {
      conversationCreating.delete(conversationId);
    }
    if (!acquired) {
      return null;
    }
    conversation = acquired;
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
  return conversation ?? null;
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
 * turn rebuilds them against the new config. Conversations with in-flight work
 * (a live turn, a queued successor, or an active subagent) are marked stale
 * and rebuilt by `getOrCreateConversation` once that work finishes. Idle
 * conversations are disposed and dropped. Also used when provider credentials
 * change.
 */
export function evictConversationsForReload(): void {
  const subagentManager = getSubagentManager();
  for (const [id, conversation] of conversationEntries()) {
    if (conversation.hasInFlightWork()) {
      conversation.markStale();
      continue;
    }
    subagentManager.abortAllForParent(id);
    conversation.dispose();
    deleteConversation(id);
    removeFromEvictor(id);
  }
}
