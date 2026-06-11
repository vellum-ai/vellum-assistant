/**
 * Route definition for one-shot inference (LLM send).
 *
 * POST /v1/inference/send — send a user message to the configured LLM and
 *                           return the model response.
 */

import { z } from "zod";

import { getConfigReadOnly } from "../../config/loader.js";
import {
  createTimeout,
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Default provider timeout for this user-facing one-shot inference endpoint
 * when the caller supplies none. Matches the CLI's documented default wait
 * (`assistant inference send` waits up to 32 minutes), so long-running prompts
 * are not server-cancelled before the CLI's IPC budget elapses.
 */
const DEFAULT_INFERENCE_TIMEOUT_MS = 32 * 60 * 1000;

/**
 * Hard ceiling on the caller-supplied `timeoutMs`. A small margin above the
 * 32-minute default keeps a misbehaving or unbounded client from pinning a
 * provider connection open indefinitely.
 */
const MAX_INFERENCE_TIMEOUT_MS = 35 * 60 * 1000;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleInferenceSend({ body = {} }: RouteHandlerArgs) {
  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new BadRequestError("message must be a non-empty string");
  }

  const systemPrompt = body.systemPrompt as string | undefined;
  const model = body.model as string | undefined;
  const profile = body.profile as string | undefined;
  const maxTokens = body.maxTokens as number | undefined;
  const requestedTimeoutMs = body.timeoutMs as number | undefined;

  // Honor the caller's deadline (the CLI's `--timeout-seconds`), clamped to a
  // sane ceiling. Defaults to the CLI's documented 32-minute wait so long
  // inferences are not server-cancelled before the client's IPC budget.
  const timeoutMs =
    requestedTimeoutMs !== undefined
      ? Math.min(requestedTimeoutMs, MAX_INFERENCE_TIMEOUT_MS)
      : DEFAULT_INFERENCE_TIMEOUT_MS;

  // Validate --profile against the configured profile catalog.
  if (profile !== undefined) {
    const profiles = getConfigReadOnly().llm?.profiles ?? {};
    if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
      const available = Object.keys(profiles).sort();
      const hint =
        available.length > 0
          ? ` Available profiles: ${available.join(", ")}.`
          : " No profiles defined in llm.profiles.";
      throw new BadRequestError(
        `Profile "${profile}" is not defined in llm.profiles.${hint}`,
      );
    }
  }

  const provider = await getConfiguredProvider("inference", {
    overrideProfile: profile,
  });
  if (!provider) {
    throw new BadRequestError(
      "No LLM provider is configured. Run 'assistant config set llm.default.provider <provider>' to set one up.",
    );
  }

  const { signal, cleanup } = createTimeout(timeoutMs);
  try {
    const response = await provider.sendMessage([userMessage(message)], {
      systemPrompt,
      config: {
        callSite: "inference",
        max_tokens: maxTokens,
        model,
      },
      signal,
    });

    return {
      response: extractAllText(response),
      model: response.model,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_send",
    endpoint: "inference/send",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Send a message to the configured LLM",
    description:
      "Send a user message to the configured LLM provider and return the model response. " +
      "Optionally specify a system prompt, model override, named profile, or max tokens.",
    tags: ["inference"],
    requestBody: z.object({
      message: z.string().min(1),
      systemPrompt: z.string().optional(),
      model: z.string().optional(),
      profile: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
      /**
       * Caller-supplied provider deadline in ms. Clamped server-side to a
       * 35-minute ceiling; defaults to the CLI's 32-minute wait when omitted.
       */
      timeoutMs: z.number().int().positive().optional(),
    }),
    responseBody: z.object({
      response: z.string(),
      model: z.string(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    }),
    handler: handleInferenceSend,
  },
];
