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

import { buildToolDefinitions } from "../../daemon/conversation-tool-setup.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import { buildSystemPrompt } from "../../prompts/system-prompt.js";
import {
  createTimeout,
  userMessage,
} from "../../providers/provider-send-message.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";
import { getCachedIntro, setCachedIntro } from "./identity-intro-cache.js";

const log = getLogger("btw-routes");

/** Conversation key used by the client for identity intro generation. */
const IDENTITY_INTRO_KEY = "identity-intro";

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
  const ingressCheck = checkIngressForSecrets(trimmedContent);
  if (ingressCheck.blocked) {
    log.warn(
      { detectedTypes: ingressCheck.detectedTypes },
      "Blocked /v1/btw message containing secrets",
    );
    return Response.json(
      {
        accepted: false,
        error: "secret_blocked",
        message: ingressCheck.userNotice,
        detectedTypes: ingressCheck.detectedTypes,
      },
      { status: 422 },
    );
  }

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

  const messages = [...conversation.getMessages(), userMessage(trimmedContent)];
  const tools = buildToolDefinitions();
  const { signal: timeoutSignal, cleanup: cleanupTimeout } =
    createTimeout(30_000);

  // Combine the timeout signal with the request's abort signal so that
  // disconnection or timeout both cancel the provider call.
  const combinedController = new AbortController();
  const onTimeoutAbort = () => combinedController.abort();
  const onRequestAbort = () => combinedController.abort();
  timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });
  req.signal.addEventListener("abort", onRequestAbort, { once: true });
  const combinedSignal = combinedController.signal;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          // Preserve any conversation-specific systemPromptOverride so
          // side-chain responses match the active conversation contract.  Only
          // fall back to a fresh prompt (excluding BOOTSTRAP.md) for
          // default conversations where no override was provided.
          const systemPrompt = conversation.hasSystemPromptOverride
            ? conversation.systemPrompt
            : buildSystemPrompt({ excludeBootstrap: true });

          const isIntroRequest = conversationKey === IDENTITY_INTRO_KEY;
          let textDeltaCount = 0;
          let collectedText = "";
          await conversation.provider.sendMessage(
            messages,
            tools,
            systemPrompt,
            {
              config: {
                max_tokens: 1024,
                tool_choice: { type: "none" },
                modelIntent: "latency-optimized",
              },
              onEvent: (event) => {
                if (event.type === "text_delta") {
                  textDeltaCount++;
                  if (isIntroRequest) collectedText += event.text;
                  controller.enqueue(
                    encoder.encode(
                      `event: btw_text_delta\ndata: ${JSON.stringify({ text: event.text })}\n\n`,
                    ),
                  );
                }
              },
              signal: combinedSignal,
            },
          );

          if (textDeltaCount === 0) {
            log.warn(
              { conversationKey, messageCount: messages.length },
              "btw side-chain completed with no text deltas",
            );
          }

          // Cache the generated identity intro for subsequent requests.
          if (isIntroRequest && collectedText.trim()) {
            try {
              setCachedIntro(collectedText.trim());
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
        } finally {
          cleanupTimeout();
          timeoutSignal.removeEventListener("abort", onTimeoutAbort);
          req.signal.removeEventListener("abort", onRequestAbort);
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
      handler: async ({ req, authContext }) =>
        handleBtw(req, deps, authContext),
    },
  ];
}
