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
 * No messages are persisted. `conversation.processing` is never set or checked.
 */

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { readNowScratchpad } from "../../daemon/conversation-runtime-assembly.js";
import { getOrCreateConversation } from "../../daemon/conversation-store.js";
import { buildToolDefinitions } from "../../daemon/conversation-tool-setup.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import { resolvePersonaContext } from "../../prompts/persona-resolver.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import { getCachedIntro, setCachedIntro } from "./identity-intro-cache.js";
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

  // ----- Identity intro fast-path -----
  if (conversationKey === IDENTITY_INTRO_KEY) {
    let fastText: string | undefined;
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    if (existsSync(identityPath)) {
      const fields = parseIdentityFields(readFileSync(identityPath, "utf-8"));
      if (fields.name) {
        fastText = `Hi, I'm ${fields.name}!`;
      }
    }
    fastText ??= getCachedIntro()?.text;
    if (fastText) {
      log.debug("Returning identity intro fast-path");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(sseEvent("btw_text_delta", { text: fastText }));
          controller.enqueue(sseEvent("btw_complete", {}));
          controller.close();
        },
      });
    }
  }

  // ----- Greeting context enrichment -----
  let effectiveContent = trimmedContent;
  if (conversationKey === GREETING_KEY) {
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
          const { userPersona, userSlug, channelPersona } =
            resolvePersonaContext(undefined, undefined);
          const result = await runBtwSidechain({
            content: effectiveContent,
            conversation,
            tools: buildToolDefinitions(),
            signal: abortSignal,
            userPersona,
            channelPersona,
            userSlug,
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
              setCachedIntro(result.text);
              log.debug("Cached identity intro text");
            } catch {
              // Non-fatal — next request will regenerate.
            }
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "runBtwSidechain",
    endpoint: "btw",
    method: "POST",
    policyKey: "btw",
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
