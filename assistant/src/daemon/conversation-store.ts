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
 * prompt assembly, and DB hydration. DaemonServer calls
 * {@link initConversationLifecycle} once at construction time to
 * supply the few remaining lifecycle references (evictor, CES client,
 * shared rate-limit timestamps, broadcast).
 */

import { getConfig } from "../config/loader.js";
import type { CesClient } from "../credential-execution/client.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { getProvider } from "../providers/registry.js";
import { getSubagentManager } from "../subagent/index.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import { Conversation, DEFAULT_MEMORY_POLICY } from "./conversation.js";
import type { ConversationEvictor } from "./conversation-evictor.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { buildTransportHints } from "./transport-hints.js";

// ── Private store ──────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();

// ── Read helpers ───────────────────────────────────────────────────

export function findConversation(
  conversationId: string,
): Conversation | undefined {
  return conversations.get(conversationId);
}

export function findConversationBySurfaceId(
  surfaceId: string,
): Conversation | undefined {
  // Fast path: exact surfaceId match in surfaceState
  for (const c of conversations.values()) {
    if (c.surfaceState.has(surfaceId)) return c;
  }

  // Fallback: standalone app surfaces use "app-open-{appId}" IDs that
  // were never part of any conversation.  Extract the appId and find
  // a conversation whose surfaceState has a surface for that app.
  const appOpenPrefix = "app-open-";
  if (surfaceId.startsWith(appOpenPrefix)) {
    const appId = surfaceId.slice(appOpenPrefix.length);
    for (const c of conversations.values()) {
      for (const [, state] of c.surfaceState.entries()) {
        const data = state.data as unknown as Record<string, unknown>;
        if (data?.appId === appId) {
          // Register this surfaceId so subsequent lookups are O(1)
          c.surfaceState.set(surfaceId, state);
          return c;
        }
      }
    }
  }

  return undefined;
}

function conversationCount(): number {
  return conversations.size;
}

/** Iterate over all active conversations. */
export function allConversations(): IterableIterator<Conversation> {
  return conversations.values();
}

/** Iterate over all [id, conversation] entries. */
export function conversationEntries(): IterableIterator<
  [string, Conversation]
> {
  return conversations.entries();
}

/** Iterate over all active conversation IDs. */
function conversationIds(): IterableIterator<string> {
  return conversations.keys();
}

// ── Write helpers ──────────────────────────────────────────────────

export function setConversation(
  conversationId: string,
  conversation: Conversation,
): void {
  conversations.set(conversationId, conversation);
}

export function deleteConversation(conversationId: string): boolean {
  return conversations.delete(conversationId);
}

export function clearConversations(): void {
  conversations.clear();
}

// ── Underlying Map (for the evictor, which takes a mutable ref) ───

/**
 * Expose the raw Map for the {@link ConversationEvictor}, which needs
 * a mutable reference to delete entries during sweeps. No other code
 * should use this — prefer the named helpers above.
 */
export function getConversationMap(): Map<string, Conversation> {
  return conversations;
}

// ── Per-conversation persistent options ────────────────────────────

const conversationOptions = new Map<string, ConversationCreateOptions>();

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

/** Lifecycle refs injected once by DaemonServer at construction. */
let _evictor: ConversationEvictor | null = null;
let _cesClientPromise: Promise<CesClient | undefined> | undefined;
let _sharedRequestTimestamps: number[] = [];

/**
 * One-time initialization called by DaemonServer to supply lifecycle
 * references that the conversation creation logic needs.
 */
export function initConversationLifecycle(refs: {
  evictor: ConversationEvictor;
  cesClientPromise?: Promise<CesClient | undefined>;
  sharedRequestTimestamps: number[];
}): void {
  _evictor = refs.evictor;
  _cesClientPromise = refs.cesClientPromise;
  _sharedRequestTimestamps = refs.sharedRequestTimestamps;
}

/**
 * Update the CES client promise after async initialization completes.
 */
export function setCesClientPromise(
  p: Promise<CesClient | undefined> | undefined,
): void {
  _cesClientPromise = p;
}

function applyTransportMetadata(
  conversation: Conversation,
  options: ConversationCreateOptions | undefined,
): void {
  const transport = options?.transport;
  if (!transport) return;
  conversation.setTransportHints(buildTransportHints(transport));
  conversation.applyHostEnvFromTransport(transport);
}

/**
 * Get or create an active conversation by ID.
 *
 * Handles provider setup, rate limiting, system prompt, memory policy,
 * and conversation hydration. Caller must have called
 * {@link initConversationLifecycle} first (DaemonServer does this at
 * construction).
 */
export async function getOrCreateConversation(
  conversationId: string,
  options?: ConversationCreateOptions,
): Promise<Conversation> {
  let conversation = findConversation(conversationId);
  const sendToClient = () => {};

  const { taskRunId: _taskRunId, ...persistentOptions } = options ?? {};
  if (Object.values(persistentOptions).some((v) => v !== undefined)) {
    mergeConversationOptions(conversationId, persistentOptions);
  }

  if (
    !conversation ||
    (conversation.isStale() && !conversation.isProcessing())
  ) {
    if (conversation) {
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
      let provider = getProvider(config.llm.default.provider);
      provider = new CallSiteRoutingProvider(provider, (name) => {
        try {
          return getProvider(name);
        } catch {
          return undefined;
        }
      });
      const { rateLimit } = config;
      if (rateLimit.maxRequestsPerMinute > 0) {
        provider = new RateLimitProvider(
          provider,
          rateLimit,
          _sharedRequestTimestamps,
        );
      }
      const workingDir = getSandboxWorkingDir();

      const systemPrompt =
        storedOptions?.systemPromptOverride ?? buildSystemPrompt();
      const maxTokens = storedOptions?.maxResponseTokens;

      const sharedCesClient = _cesClientPromise
        ? await _cesClientPromise
        : undefined;
      const newConversation = new Conversation(
        conversationId,
        provider,
        systemPrompt,
        maxTokens,
        sendToClient,
        workingDir,
        DEFAULT_MEMORY_POLICY,
        sharedCesClient,
        storedOptions?.speed,
        undefined,
        storedOptions?.modelOverride,
      );
      newConversation.updateClient(sendToClient, true);
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
      setConversation(conversationId, newConversation);
      return newConversation;
    })();

    conversationCreating.set(conversationId, createPromise);
    try {
      conversation = await createPromise;
    } finally {
      conversationCreating.delete(conversationId);
    }
    _evictor?.touch(conversationId);
  } else {
    if (!conversation.isProcessing()) {
      applyTransportMetadata(conversation, options);
      if (options?.trustContext !== undefined) {
        conversation.setTrustContext(options.trustContext);
      }
    }
    _evictor?.touch(conversationId);
  }
  return conversation;
}

// ---------------------------------------------------------------------------
// Thin evictor wrappers — so callers don't need the DaemonServer instance
// ---------------------------------------------------------------------------

export function touchConversation(conversationId: string): void {
  _evictor?.touch(conversationId);
}

function removeFromEvictor(conversationId: string): void {
  _evictor?.remove(conversationId);
}

/**
 * Abort, dispose, and remove a single in-memory conversation.
 * Use before deleting the DB row so the agent loop can't write to a
 * deleted conversation and trip FK constraints.
 */
export function destroyActiveConversation(conversationId: string): void {
  const conversation = findConversation(conversationId);
  if (!conversation) return;
  removeFromEvictor(conversationId);
  getSubagentManager().abortAllForParent(conversationId);
  conversation.dispose();
  deleteConversation(conversationId);
  deleteConversationOptions(conversationId);
}

/**
 * Dispose all in-memory conversations, clear the store, and remove
 * from the evictor. Returns the count of conversations that were cleared.
 */
export function clearAllActiveConversations(): number {
  const count = conversationCount();
  const subagentManager = getSubagentManager();
  for (const id of conversationIds()) {
    removeFromEvictor(id);
    subagentManager.abortAllForParent(id);
  }
  for (const conversation of allConversations()) {
    conversation.dispose();
  }
  clearConversations();
  clearConversationOptions();
  return count;
}
