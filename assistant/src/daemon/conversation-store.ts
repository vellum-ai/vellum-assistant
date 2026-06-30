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

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import { resolveDefaultProvider } from "../providers/connection-resolution.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { listProviders } from "../providers/registry.js";
import { getSubagentManager } from "../subagent/index.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import { Conversation } from "./conversation.js";
import {
  removeFromEvictor,
  touchConversation,
} from "./conversation-evictor.js";
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
  if (!transport) return;
  conversation.setTransportHints(buildTransportHints(transport));
  conversation.applyHostEnvFromTransport(transport);
  conversation.applyClientTimezoneFromTransport(transport);
  conversation.applyClientOsFromTransport(transport);
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
      // Connection-aware default-provider resolution. Throws
      // `ConnectionResolutionError` when the default profile's
      // `provider_connection` is unset / unknown / mismatched (config
      // bugs). Returns null on soft credential failures (missing
      // credential, platform auth unavailable).
      const baseProvider = await resolveDefaultProvider(config);
      if (!baseProvider) {
        const resolved = resolveCallSiteConfig("mainAgent", config.llm);
        throw new ProviderNotConfiguredError(
          resolved.provider,
          listProviders(),
          {
            connectionName: resolved.provider_connection,
          },
        );
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

      const systemPrompt =
        storedOptions?.systemPromptOverride ?? buildSystemPrompt();
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
          // `systemPrompt` above is the default base build unless a real
          // override was supplied. Signal which explicitly so a normal chat
          // rebuilds the prompt per turn (picking up live trust/persona) rather
          // than freezing onto a non-deterministic construction-time build.
          hasSystemPromptOverride:
            storedOptions?.systemPromptOverride !== undefined,
        },
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

/**
 * Evict in-memory conversations after a config/prompt/skills reload so the next
 * turn rebuilds them against the new config. Idle conversations are disposed and
 * dropped; busy ones are marked stale so they're rebuilt once their current turn
 * finishes. Also used when provider credentials change.
 */
export function evictConversationsForReload(): void {
  const subagentManager = getSubagentManager();
  for (const [id, conversation] of conversationEntries()) {
    if (!conversation.isProcessing()) {
      subagentManager.abortAllForParent(id);
      conversation.dispose();
      deleteConversation(id);
      removeFromEvictor(id);
    } else {
      conversation.markStale();
    }
  }
}
