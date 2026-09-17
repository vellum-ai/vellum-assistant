import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError, type ProviderErrorReason } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { safeStringSlice } from "../../util/unicode.js";
import { fileBlockToProviderText } from "../file-block-text.js";
import { recordProviderRequestDiagnostics } from "../request-diagnostics.js";
import { createStreamTimeout } from "../stream-timeout.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

const log = getLogger("jev-client");

export const JEV_PROVIDER_ID = "jev";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";

const SYSTEM_ONE_PATH = "/v1/systemone";
const MODELS_PATH = "/v1/models";
const VALIDATION_TIMEOUT_MS = 10_000;
/** TypeSafe's published request budget is about 32k tokens / 150k English characters. */
const MAX_STATE_CHARS = 140_000;

export interface JevProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

export type ApiKeyValidationResult =
  { valid: true } | { valid: false; reason: string };

export type JevJsonValue =
  | string
  | number
  | boolean
  | null
  | JevJsonValue[]
  | { [key: string]: JevJsonValue };

export type JevQuestion = {
  type: "choice" | "score" | "noul";
  instructions: string;
  criteria?: JevJsonValue;
};

export type JevQuestions = Record<string, JevQuestion>;

export interface JevSystemOneRequest {
  state: JevJsonValue;
  model: string;
  questions: JevQuestions;
}

export interface JevSystemOneResult {
  model: string;
  answers: Record<string, JevJsonValue>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const DEFAULT_EXPERIMENT_QUESTIONS: JevQuestions = {
  actionable: {
    type: "noul",
    instructions:
      "Does the latest user message ask the assistant to take a specific action?",
  },
};

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveBaseUrl(baseURL?: string): string {
  const trimmed = baseURL?.trim();
  return trimTrailingSlash(
    trimmed && trimmed.length > 0 ? trimmed : DEFAULT_JEV_BASE_URL,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJevQuestion(value: unknown): value is JevQuestion {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  if (type !== "choice" && type !== "score" && type !== "noul") {
    return false;
  }
  if (
    typeof value.instructions !== "string" ||
    value.instructions.trim().length === 0
  ) {
    return false;
  }
  return true;
}

function isJevQuestions(value: unknown): value is JevQuestions {
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([, question]) => isJevQuestion(question));
}

/**
 * If the last user message is a TypeSafe System One payload, use it as the
 * evaluation request. `state` is optional; callers fall back to the
 * conversation when it is omitted.
 */
export function parseSystemOneOverride(
  text: string,
): { state?: JevJsonValue; questions: JevQuestions } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isJevQuestions(parsed.questions)) {
    return null;
  }
  return {
    questions: parsed.questions,
    ...(parsed.state !== undefined
      ? { state: parsed.state as JevJsonValue }
      : {}),
  };
}

function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "file":
      return fileBlockToProviderText(block);
    case "image":
      return "[image]";
    case "tool_use":
      return `[tool_use ${block.name} ${JSON.stringify(block.input)}]`;
    case "tool_result":
      return `[tool_result ${block.tool_use_id}${
        block.content ? ` ${block.content}` : ""
      }]`;
    default:
      return "";
  }
}

function messageToText(message: Message): string {
  return message.content
    .map((block) => contentBlockToText(block))
    .filter((part) => part.length > 0)
    .join("\n");
}

export function conversationToState(
  messages: Message[],
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push(`system:\n${systemPrompt}`);
  }
  for (const message of messages) {
    const text = messageToText(message);
    if (text.length === 0) {
      continue;
    }
    parts.push(`${message.role}:\n${text}`);
  }
  return safeStringSlice(parts.join("\n\n"), 0, MAX_STATE_CHARS);
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") {
      continue;
    }
    const text = messageToText(message).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function classifyHttpStatus(status: number): ProviderErrorReason {
  if (status === 401 || status === 403) {
    return "invalid_credentials";
  }
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 529) {
    return "overloaded";
  }
  if (status >= 500) {
    return "server_error";
  }
  if (status >= 400) {
    return "bad_request";
  }
  return "unknown";
}

function extractErrorMessage(bodyText: string, status: number): string {
  const trimmed = bodyText.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      const nested =
        parsed.error && isRecord(parsed.error)
          ? parsed.error.message
          : parsed.error;
      const candidate = nested ?? parsed.message ?? parsed.detail;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    } catch {
      // Fall through to the raw body.
    }
    return safeStringSlice(trimmed, 0, 500);
  }
  return `TypeSafe API error (${status})`;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Validate a TypeSafe API key with a tiny System One request. Definitive
 * auth failures (401/403) reject the key; transient errors allow storage.
 */
export async function validateJevApiKey(
  apiKey: string,
  options: { baseURL?: string } = {},
): Promise<ApiKeyValidationResult> {
  const baseURL = resolveBaseUrl(options.baseURL);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("TypeSafe key validation timed out"));
  }, VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseURL}${MODELS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return { valid: false, reason: "API key is invalid or expired." };
    }
    if (response.status === 403) {
      const body = await readResponseText(response);
      return {
        valid: false,
        reason: extractErrorMessage(body, response.status),
      };
    }
    if (response.status === 404) {
      return await validateJevApiKeyViaSystemOne(apiKey, baseURL);
    }
    if (response.ok) {
      return { valid: true };
    }
    log.warn(
      { status: response.status },
      "TypeSafe API returned a transient error during key validation, allowing key",
    );
    return { valid: true };
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during TypeSafe key validation, allowing key",
    );
    return { valid: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateJevApiKeyViaSystemOne(
  apiKey: string,
  baseURL: string,
): Promise<ApiKeyValidationResult> {
  try {
    const response = await fetch(`${baseURL}${SYSTEM_ONE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: "ok",
        model: DEFAULT_JEV_MODEL,
        questions: {
          probe: {
            type: "noul",
            instructions: "Is this a non-empty string?",
          },
        },
      } satisfies JevSystemOneRequest),
    });
    if (response.status === 401) {
      return { valid: false, reason: "API key is invalid or expired." };
    }
    if (response.status === 403) {
      const body = await readResponseText(response);
      return {
        valid: false,
        reason: extractErrorMessage(body, response.status),
      };
    }
    if (!response.ok && response.status < 500 && response.status !== 429) {
      const body = await readResponseText(response);
      return {
        valid: false,
        reason: extractErrorMessage(body, response.status),
      };
    }
    return { valid: true };
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during TypeSafe System One key validation, allowing key",
    );
    return { valid: true };
  }
}

export class JevProvider implements Provider {
  public readonly name = JEV_PROVIDER_ID;
  public readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly streamTimeoutMs: number;

  constructor(apiKey: string, model: string, options: JevProviderOptions = {}) {
    this.apiKey = apiKey;
    this.defaultModel = model.trim() || DEFAULT_JEV_MODEL;
    this.baseURL = resolveBaseUrl(options.baseURL);
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
  }

  /**
   * Native TypeSafe System One call. `sendMessage` is a thin adapter over
   * this so existing profiles and probes can reach Jev.
   */
  async systemOne(
    request: JevSystemOneRequest,
    options: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
    } = {},
  ): Promise<JevSystemOneResult> {
    const url = `${this.baseURL}${SYSTEM_ONE_PATH}`;
    recordProviderRequestDiagnostics({ model_id: request.model });
    const { signal, cleanup } = createStreamTimeout(
      this.streamTimeoutMs,
      options.signal,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(request),
        signal,
      });
      const bodyText = await readResponseText(response);
      if (!response.ok) {
        const reason = classifyHttpStatus(response.status);
        throw new ProviderError(
          extractErrorMessage(bodyText, response.status),
          JEV_PROVIDER_ID,
          response.status,
          { reason, rawBody: bodyText },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        throw new ProviderError(
          "TypeSafe returned a non-JSON response.",
          JEV_PROVIDER_ID,
          response.status,
          { reason: "bad_request", rawBody: bodyText },
        );
      }
      if (!isRecord(parsed) || !isRecord(parsed.answers)) {
        throw new ProviderError(
          "TypeSafe returned a response without answers.",
          JEV_PROVIDER_ID,
          response.status,
          { reason: "bad_request", rawBody: bodyText },
        );
      }
      const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
      return {
        model:
          typeof parsed.model === "string" && parsed.model.length > 0
            ? parsed.model
            : request.model,
        answers: parsed.answers as Record<string, JevJsonValue>,
        ...(usage
          ? {
              usage: {
                input_tokens:
                  typeof usage.input_tokens === "number"
                    ? usage.input_tokens
                    : undefined,
                output_tokens:
                  typeof usage.output_tokens === "number"
                    ? usage.output_tokens
                    : undefined,
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      const abortReason =
        options.signal?.aborted && isAbortReason(options.signal.reason)
          ? options.signal.reason
          : undefined;
      throw new ProviderError(
        error instanceof Error ? error.message : String(error),
        JEV_PROVIDER_ID,
        undefined,
        {
          cause: error,
          abortReason,
          reason: abortReason ? undefined : "network_error",
        },
      );
    } finally {
      cleanup();
    }
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { systemPrompt, config, onEvent, signal } = options ?? {};
    const configObj = config as Record<string, unknown> | undefined;
    const modelOverride = configObj?.model as string | undefined;
    const usageAttributionHeaders = configObj?.usageAttributionHeaders as
      Record<string, string> | undefined;
    const activeModel = modelOverride?.trim() || this.defaultModel;
    const override = parseSystemOneOverride(lastUserText(messages));
    const request: JevSystemOneRequest = {
      model: activeModel,
      state: override?.state ?? conversationToState(messages, systemPrompt),
      questions: override?.questions ?? DEFAULT_EXPERIMENT_QUESTIONS,
    };

    const result = await this.systemOne(request, {
      signal,
      headers: usageAttributionHeaders,
    });
    const text = JSON.stringify(result.answers, null, 2);
    onEvent?.({ type: "text_delta", text });

    return {
      content: [{ type: "text", text }],
      model: result.model,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      },
      stopReason: "end_turn",
      resolvedEndpoint: `${this.baseURL}${SYSTEM_ONE_PATH}`,
      rawRequest: request,
      rawResponse: result,
    };
  }
}
