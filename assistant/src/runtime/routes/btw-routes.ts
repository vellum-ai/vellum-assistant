/**
 * HTTP route handler for the POST /v1/btw SSE-streaming side-chain endpoint.
 *
 * Runs an ephemeral LLM call that reuses the session's provider, system prompt,
 * tool definitions, and message history for prompt-cache efficiency. The response
 * is streamed as SSE events (`btw_text_delta`, `btw_complete`, `btw_error`).
 *
 * No messages are persisted. `session.processing` is never set or checked.
 */

import { buildToolDefinitions } from "../../daemon/session-tool-setup.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import {
  createTimeout,
  userMessage,
} from "../../providers/provider-send-message.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { getLogger } from "../../util/logger.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";

const log = getLogger("btw-routes");

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

  // Look up an existing conversation — never create one.  BTW is ephemeral
  // (the file header promises "No messages are persisted"), so we must not
  // call getOrCreateConversation which would insert a DB row.  When no
  // conversation exists (e.g. greeting generation for a draft thread), we
  // still get a usable session via getOrCreateSession with the raw key; the
  // session lives only in memory and disappears on restart.
  const mapping = getConversationByKey(conversationKey);
  const sessionId = mapping?.conversationId ?? conversationKey;
  const session = await deps.sendMessageDeps.getOrCreateSession(sessionId);

  const messages = [...session.getMessages(), userMessage(trimmedContent)];
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
          await session.provider.sendMessage(
            messages,
            tools,
            session.systemPrompt,
            {
              config: {
                max_tokens: 1024,
                tool_choice: { type: "none" },
                modelIntent: "latency-optimized",
              },
              onEvent: (event) => {
                if (event.type === "text_delta") {
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
