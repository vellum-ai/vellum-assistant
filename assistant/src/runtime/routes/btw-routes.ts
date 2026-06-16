/**
 * Route handler for the POST /v1/btw SSE-streaming side-chain endpoint.
 *
 * Runs an ephemeral LLM call that reuses the conversation's provider, tool
 * definitions, and message history for prompt-cache efficiency. Uses the
 * conversation's system prompt when a conversation-specific override is active;
 * otherwise builds a fresh prompt excluding BOOTSTRAP.md so first-run
 * onboarding instructions don't leak into cosmetic UI calls like identity
 * intro generation. The response is streamed as SSE events (`btw_text_delta`,
 * `btw_complete`, `btw_error`).
 *
 * No messages are persisted. The conversation's processing flag is never set or checked.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getOrCreateConversation } from "../../daemon/conversation-store.js";
import { readNowScratchpad } from "../../daemon/now-scratchpad.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import { getAllToolDefinitions } from "../../tools/registry.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import {
  getCachedEmptyStateGreeting,
  setCachedEmptyStateGreeting,
} from "./empty-state-greeting-cache.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import {
  getCachedIntro,
  readWorkspaceGreetings,
  setCachedIntro,
} from "./identity-intro-cache.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("btw-routes");

/** Conversation key used by the client for identity intro generation. */
const IDENTITY_INTRO_KEY = "identity-intro";

/** Conversation key used by the client for empty-state greeting generation. */
const GREETING_KEY = "greeting";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleBtw({
  body,
  abortSignal,
}: RouteHandlerArgs): Promise<ReadableStream<Uint8Array>> {
  const conversationKey = body?.conversationKey as string | undefined;
  const content = body?.content as string | undefined;

  if (!conversationKey) {
    throw new BadRequestError("conversationKey is required");
  }
  if (!content || typeof content !== "string") {
    throw new BadRequestError("content must be a non-empty string");
  }

  const trimmedContent = content.trim();

  // ----- Cached identity intro fast-path -----
  if (conversationKey === IDENTITY_INTRO_KEY) {
    const fastText = getCachedIntro()?.greetings[0];
    if (fastText) {
      log.debug("Returning identity intro fast-path");
      return streamText(fastText);
    }
  }

  // ----- Empty-state greeting fast-path -----
  // User-authored `## Greetings` win; otherwise replay a cached greeting when
  // one is fresh within the configurable TTL (`ui.emptyStateGreetingCacheTtlMs`,
  // 0 = always regenerate). Either path avoids an LLM call and streams the
  // text straight back.
  if (conversationKey === GREETING_KEY) {
    const authored = readWorkspaceGreetings();
    if (authored && authored.length > 0) {
      log.debug("Returning authored empty-state greeting");
      return streamText(pickRandom(authored));
    }
    const cached = getCachedEmptyStateGreeting();
    if (cached) {
      log.debug("Returning cached empty-state greeting");
      return streamText(cached);
    }
  }

  // ----- Greeting context enrichment -----
  let effectiveContent = trimmedContent;
  if (
    conversationKey === GREETING_KEY &&
    getConfig().memory.retrieval.scratchpadInjection.enabled
  ) {
    const now = readNowScratchpad();
    if (now) {
      effectiveContent = `${trimmedContent}\n\n<context>\n${now}\n</context>`;
    }
  }

  // Look up an existing conversation or create an ephemeral one.
  const mapping = getConversationByKey(conversationKey);
  const conversationId = mapping?.conversationId ?? conversationKey;

  let conversation;
  try {
    conversation = await getOrCreateConversation(conversationId);
  } catch {
    throw new ServiceUnavailableError("Message processing is not available");
  }

  return new ReadableStream({
    start(controller) {
      (async () => {
        try {
          const isIntroRequest = conversationKey === IDENTITY_INTRO_KEY;
          const isGreeting = conversationKey === GREETING_KEY;
          const result = await runBtwSidechain({
            content: effectiveContent,
            conversation,
            tools: getAllToolDefinitions(),
            signal: abortSignal,
            ...(isGreeting ? { callSite: "emptyStateGreeting" as const } : {}),
            onEvent: (event) => {
              if (event.type === "text_delta") {
                controller.enqueue(
                  sseEvent("btw_text_delta", { text: event.text }),
                );
              }
            },
          });

          if (!result.hadTextDeltas) {
            log.warn(
              {
                conversationKey,
                messageCount: conversation.getMessages().length + 1,
              },
              "btw side-chain completed with no text deltas",
            );
          }

          if (isIntroRequest && result.text) {
            try {
              setCachedIntro([result.text]);
              log.debug("Cached identity intro text");
            } catch {
              // Non-fatal — next request will regenerate.
            }
          }

          if (isGreeting && result.text) {
            // setCachedEmptyStateGreeting is a no-op when the TTL is 0.
            setCachedEmptyStateGreeting(result.text);
            log.debug("Cached empty-state greeting text");
          }

          controller.enqueue(sseEvent("btw_complete", {}));
          controller.close();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          log.error({ err }, "btw side-chain streaming error");
          try {
            controller.enqueue(sseEvent("btw_error", { error: message }));
            controller.close();
          } catch {
            /* stream already closed */
          }
        }
      })();
    },
  });
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function streamText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(sseEvent("btw_text_delta", { text }));
      controller.enqueue(sseEvent("btw_complete", {}));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "runBtwSidechain",
    endpoint: "btw",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Run ephemeral LLM side-chain",
    description:
      "Stream an ephemeral LLM call reusing the conversation's provider and message history. Response is SSE (btw_text_delta, btw_complete, btw_error).",
    tags: ["btw"],
    responseHeaders: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    requestBody: z.object({
      conversationKey: z
        .string()
        .describe("Conversation key to scope the call"),
      content: z.string().describe("User prompt content"),
    }),
    handler: handleBtw,
  },
];
