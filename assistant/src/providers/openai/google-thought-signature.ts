import { unsignedThoughtSignatureFallback } from "../gemini-thought-signature.js";

export type GoogleToolCallExtraContent = {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function googleObjectThoughtSignature(google: unknown): string | undefined {
  if (google === null || typeof google !== "object") {
    return undefined;
  }
  const record = google as Record<string, unknown>;
  return (
    asNonEmptyString(record.thought_signature) ??
    asNonEmptyString(record.thoughtSignature)
  );
}

/**
 * Gemini's OpenAI-compatible wire format puts the thought signature on
 * `tool_calls[].extra_content.google.thought_signature`.
 */
export function googleThoughtSignatureFromUnknown(
  value: unknown,
): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const extra = (value as { extra_content?: unknown }).extra_content;
  if (extra === null || typeof extra !== "object") {
    return undefined;
  }
  return googleObjectThoughtSignature((extra as { google?: unknown }).google);
}

export function attachGoogleThoughtSignature<T extends object>(
  toolCall: T,
  thoughtSignature: string | undefined,
): T & GoogleToolCallExtraContent {
  if (!thoughtSignature) {
    return toolCall;
  }
  return {
    ...toolCall,
    extra_content: {
      google: { thought_signature: thoughtSignature },
    },
  };
}

function stampUnsignedGoogleThoughtSignature(
  toolCalls: GoogleToolCallExtraContent[],
  options?: { model?: string },
): boolean {
  const fallback = unsignedThoughtSignatureFallback(
    toolCalls.map((tc) => googleThoughtSignatureFromUnknown(tc)),
    options,
  );
  if (!fallback) {
    return false;
  }
  const target = toolCalls[fallback.index];
  if (!target) {
    return false;
  }
  target.extra_content = {
    google: { thought_signature: fallback.signature },
  };
  return true;
}

/**
 * Gemini 3.x validates the first function call of each step. When none of the
 * serialized tool_calls carry a captured signature, attach the documented dummy
 * so unsigned history (or a non-capturing earlier turn) does not 400.
 */
export function applyGemini3UnsignedToolCallFallback(
  toolCalls: GoogleToolCallExtraContent[],
  model: string,
): void {
  stampUnsignedGoogleThoughtSignature(toolCalls, { model });
}

function paramsMessages(params: unknown): unknown[] | undefined {
  const messages = (params as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

function assistantToolCalls(
  msg: unknown,
): GoogleToolCallExtraContent[] | undefined {
  if (msg === null || typeof msg !== "object") {
    return undefined;
  }
  const record = msg as { role?: unknown; tool_calls?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
    return undefined;
  }
  return record.tool_calls as GoogleToolCallExtraContent[];
}

export function messagesCarryGoogleThoughtSignature(params: unknown): boolean {
  const messages = paramsMessages(params);
  if (!messages) {
    return false;
  }
  return messages.some((msg) => {
    const toolCalls = assistantToolCalls(msg);
    return toolCalls?.some((tc) => googleThoughtSignatureFromUnknown(tc));
  });
}

export function assistantToolCallsNeedThoughtSignatureBackfill(
  params: unknown,
): boolean {
  const messages = paramsMessages(params);
  if (!messages) {
    return false;
  }
  return messages.some((msg) => {
    const toolCalls = assistantToolCalls(msg);
    if (!toolCalls || toolCalls.length === 0) {
      return false;
    }
    return !toolCalls.some((tc) => googleThoughtSignatureFromUnknown(tc));
  });
}

export function stripGoogleThoughtSignatures(params: unknown): boolean {
  const messages = paramsMessages(params);
  if (!messages) {
    return false;
  }
  let stripped = false;
  for (const msg of messages) {
    const toolCalls = assistantToolCalls(msg);
    if (!toolCalls) {
      continue;
    }
    for (const tc of toolCalls) {
      if (tc.extra_content !== undefined) {
        delete tc.extra_content;
        stripped = true;
      }
    }
  }
  return stripped;
}

export function backfillUnsignedGoogleThoughtSignatures(
  params: unknown,
): boolean {
  const messages = paramsMessages(params);
  if (!messages) {
    return false;
  }
  let added = false;
  for (const msg of messages) {
    const toolCalls = assistantToolCalls(msg);
    if (!toolCalls || toolCalls.length === 0) {
      continue;
    }
    if (stampUnsignedGoogleThoughtSignature(toolCalls)) {
      added = true;
    }
  }
  return added;
}
