/**
 * Route definitions for inference operations.
 *
 * POST inference/send — Send a message to the configured LLM provider.
 *   Supports both one-shot (JSON response) and streaming (IpcStreamingResponse).
 */

import { loadConfig } from "../../config/loader.js";
import { IpcStreamingResponse } from "../../ipc/assistant-server.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BadRequestError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleInferenceSend(args: RouteHandlerArgs) {
  const body = args.body as Record<string, unknown> | undefined;
  const message = body?.message as string | undefined;
  const systemPrompt = body?.systemPrompt as string | undefined;
  const model = body?.model as string | undefined;
  const profile = body?.profile as string | undefined;
  const maxTokens = body?.maxTokens as number | undefined;
  const stream = body?.stream as boolean | undefined;

  if (!message) throw new BadRequestError("message is required");

  if (profile !== undefined) {
    const profiles = loadConfig().llm?.profiles ?? {};
    if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
      throw new BadRequestError(`Profile "${profile}" is not defined in llm.profiles`);
    }
  }

  const provider = await getConfiguredProvider("inference", {
    overrideProfile: profile ?? undefined,
  });
  if (!provider) {
    throw new RouteError(
      "No LLM provider configured. Run 'assistant config set llm.default.provider <provider>'",
      "NO_PROVIDER",
      503,
    );
  }

  if (stream === true) {
    const enc = new TextEncoder();
    const readableStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const response = await provider.sendMessage(
            [userMessage(message)],
            undefined,
            systemPrompt,
            { config: { callSite: "inference", max_tokens: maxTokens, model } },
          );
          const text = extractAllText(response);
          controller.enqueue(enc.encode(text));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
    return { stream: readableStream, headers: { "content-type": "text/plain" } } satisfies IpcStreamingResponse;
  }

  const response = await provider.sendMessage(
    [userMessage(message)],
    undefined,
    systemPrompt,
    { config: { callSite: "inference", max_tokens: maxTokens, model } },
  );
  return {
    ok: true,
    response: extractAllText(response),
    model: response.model,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_send",
    endpoint: "inference/send",
    method: "POST",
    summary: "Send a message to the configured LLM provider",
    tags: ["inference"],
    handler: handleInferenceSend,
  },
];
