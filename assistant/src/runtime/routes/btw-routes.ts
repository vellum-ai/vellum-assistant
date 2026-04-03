/**
 * HTTP route handler for the POST /v1/btw SSE-streaming side-chain endpoint.
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

import { getConfig } from "../../config/loader.js";
import { readNowScratchpad } from "../../daemon/conversation-runtime-assembly.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import {
  resolveChannelPersona,
  resolveGuardianPersona,
} from "../../prompts/persona-resolver.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import type { AuthContext } from "../auth/types.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";
import { getCachedIntro, setCachedIntro } from "./identity-intro-cache.js";

const log = getLogger("btw-routes");

/** Conversation key used by the client for identity intro generation. */
const IDENTITY_INTRO_KEY = "identity-intro";

/** Conversation key used by the client for empty-state greeting generation. */
const GREETING_KEY = "greeting";

/**
 * Parse the `## Identity Intro` section from SOUL.md.
 * Returns the first non-empty line under that heading, or null.
 */
function readSoulIdentityIntro(): string | null {
  try {
    const soulPath = getWorkspacePromptPath("SOUL.md");
    if (!existsSync(soulPath)) return null;
    const content = readFileSync(soulPath, "utf-8");

    let inSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (/^#+\s/.test(trimmed)) {
        inSection = trimmed.toLowerCase().includes("identity intro");
        continue;
      }
      if (inSection && trimmed.length > 0) {
        return trimmed;
      }
    }
  } catch {
    // Fall through — no SOUL.md intro available
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleBtw(
  req: Request,
  deps: { sendMessageDeps?: SendMessageDeps },
  _authContext: AuthContext,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationKey?: string;
    content?: string;
  };

  const { conversationKey, content } = body;

  if (!conversationKey) {
    return httpError("BAD_REQUEST", "conversationKey is required", 400);
  }
  if (!content || typeof content !== "string") {
    return httpError("BAD_REQUEST", "content must be a non-empty string", 400);
  }

  if (!deps.sendMessageDeps) {
    return httpError(
      "SERVICE_UNAVAILABLE",
      "Message processing is not available",
      503,
    );
  }

  const trimmedContent = content.trim();

  // ----- Identity intro fast-path -----
  // When the client requests the identity intro, check SOUL.md first (persisted
  // during onboarding), then the LLM-generated cache. Only fall through to a
  // live LLM call when neither source has a value.
  if (conversationKey === IDENTITY_INTRO_KEY) {
    const soulIntro = readSoulIdentityIntro();
    const fastText = soulIntro ?? getCachedIntro()?.text;
    if (fastText) {
      log.debug(
        soulIntro
          ? "Returning SOUL.md identity intro"
          : "Returning cached identity intro",
      );
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: btw_text_delta\ndata: ${JSON.stringify({ text: fastText })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(`event: btw_complete\ndata: {}\n\n`),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
  }

  // ----- Greeting context enrichment -----
  // Inject NOW.md scratchpad so the model has contextual awareness (mood,
  // current activity) and produces varied, relevant greetings instead of
  // the same deterministic output each time.
  let effectiveContent = trimmedContent;
  if (conversationKey === GREETING_KEY) {
    const now = readNowScratchpad();
    if (now) {
      effectiveContent = `${trimmedContent}\n\n<context>\n${now}\n</context>`;
    }
  }

  // Look up an existing conversation — never create one.  BTW is ephemeral
  // (the file header promises "No messages are persisted"), so we must not
  // call getOrCreateConversation which would insert a DB row.  When no
  // conversation exists (e.g. greeting generation for a draft conversation), we
  // still get a usable conversation via getOrCreateConversation with the raw key; the
  // conversation lives only in memory and disappears on restart.
  const mapping = getConversationByKey(conversationKey);
  const conversationId = mapping?.conversationId ?? conversationKey;
  const conversation =
    await deps.sendMessageDeps.getOrCreateConversation(conversationId);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          const isIntroRequest = conversationKey === IDENTITY_INTRO_KEY;
          const isGreeting = conversationKey === GREETING_KEY;
          const userPersona = resolveGuardianPersona();
          const channelPersona = resolveChannelPersona(undefined);
          const result = await runBtwSidechain({
            content: effectiveContent,
            conversation,
            signal: req.signal,
            userPersona,
            channelPersona,
            ...(isGreeting
              ? { modelIntent: getConfig().ui.greetingModelIntent }
              : {}),
            onEvent: (event) => {
              if (event.type === "text_delta") {
                controller.enqueue(
                  encoder.encode(
                    `event: btw_text_delta\ndata: ${JSON.stringify({ text: event.text })}\n\n`,
                  ),
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

          // Cache the generated identity intro for subsequent requests.
          if (isIntroRequest && result.text) {
            try {
              setCachedIntro(result.text);
              log.debug("Cached identity intro text");
            } catch {
              // Non-fatal — next request will regenerate.
            }
          }

          controller.enqueue(
            encoder.encode(`event: btw_complete\ndata: {}\n\n`),
          );
          controller.close();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          log.error({ err }, "btw side-chain streaming error");
          try {
            controller.enqueue(
              encoder.encode(
                `event: btw_error\ndata: ${JSON.stringify({ error: message })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            /* stream already closed */
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function btwRouteDefinitions(deps: {
  sendMessageDeps?: SendMessageDeps;
}): RouteDefinition[] {
  return [
    {
      endpoint: "btw",
      method: "POST",
      policyKey: "btw",
      summary: "Run ephemeral LLM side-chain",
      description:
        "Stream an ephemeral LLM call reusing the conversation's provider and message history. Response is SSE (btw_text_delta, btw_complete, btw_error).",
      tags: ["btw"],
      requestBody: z.object({
        conversationKey: z
          .string()
          .describe("Conversation key to scope the call"),
        content: z.string().describe("User prompt content"),
      }),
      handler: async ({ req, authContext }) =>
        handleBtw(req, deps, authContext),
    },
  ];
}
