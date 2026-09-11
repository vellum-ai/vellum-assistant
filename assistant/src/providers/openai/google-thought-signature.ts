import {
  isGemini3Model,
  unsignedThoughtSignatureFallback,
} from "../gemini-thought-signature.js";
import type { Message, ToolUseContent } from "../types.js";

export type GoogleToolCallExtraContent = {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
};

export type GoogleThoughtSignatureRetryKind =
  | "missing-thought-signature"
  | "unknown-extra-content";

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

export function toolUseMetadataFromChatCompletionsDelta(
  delta: unknown,
): ToolUseContent["providerMetadata"] | undefined {
  const thoughtSignature = googleThoughtSignatureFromUnknown(delta);
  if (!thoughtSignature) {
    return undefined;
  }
  return { gemini: { thoughtSignature } };
}

export function thoughtSignatureFromToolUseMetadata(
  metadata: ToolUseContent["providerMetadata"] | undefined,
): string | undefined {
  return metadata?.gemini?.thoughtSignature;
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

/**
 * Attach Gemini extra_content only when the destination model is Gemini 3.x.
 * Non-Gemini Chat Completions endpoints never see the vendor field on the
 * first request. Remapped model ids that still require a signature recover
 * via {@link backfillGoogleThoughtSignatures} after a 4xx.
 */
export function attachGoogleThoughtSignatureIfNeeded<T extends object>(
  toolCall: T,
  thoughtSignature: string | undefined,
  model: string,
): T & GoogleToolCallExtraContent {
  if (!isGemini3Model(model)) {
    return toolCall;
  }
  return attachGoogleThoughtSignature(toolCall, thoughtSignature);
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

function stampCapturedGoogleThoughtSignatures(
  toolCalls: Array<GoogleToolCallExtraContent & { id?: unknown }>,
  capturedByCallId: ReadonlyMap<string, string>,
): boolean {
  let added = false;
  for (const tc of toolCalls) {
    if (typeof tc.id !== "string") {
      continue;
    }
    const captured = capturedByCallId.get(tc.id);
    if (!captured || googleThoughtSignatureFromUnknown(tc)) {
      continue;
    }
    tc.extra_content = {
      google: { thought_signature: captured },
    };
    added = true;
  }
  return added;
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
): Array<GoogleToolCallExtraContent & { id?: unknown }> | undefined {
  if (msg === null || typeof msg !== "object") {
    return undefined;
  }
  const record = msg as { role?: unknown; tool_calls?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
    return undefined;
  }
  return record.tool_calls as Array<
    GoogleToolCallExtraContent & { id?: unknown }
  >;
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

export function geminiThoughtSignaturesByToolCallId(
  messages: ReadonlyArray<Message>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      const signature = block.providerMetadata?.gemini?.thoughtSignature;
      if (signature) {
        out.set(block.id, signature);
      }
    }
  }
  return out;
}

export function backfillGoogleThoughtSignatures(
  params: unknown,
  capturedByCallId?: ReadonlyMap<string, string>,
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
    if (
      capturedByCallId &&
      stampCapturedGoogleThoughtSignatures(toolCalls, capturedByCallId)
    ) {
      added = true;
    }
    if (stampUnsignedGoogleThoughtSignature(toolCalls)) {
      added = true;
    }
  }
  return added;
}

export function backfillUnsignedGoogleThoughtSignatures(
  params: unknown,
): boolean {
  return backfillGoogleThoughtSignatures(params);
}

const UNKNOWN_EXTRA_CONTENT_REJECTION =
  /unknown|unexpected|unrecognized|additional propert|extra (?:field|property)|not (?:a )?valid|invalid (?:argument|parameter|field|property)/i;

export function classifyGoogleThoughtSignatureRetry(
  params: unknown,
  options: {
    isClientError: boolean;
    haystack: string;
    capturedByCallId?: ReadonlyMap<string, string>;
  },
): {
  kind: GoogleThoughtSignatureRetryKind;
  message: string;
  apply: () => void;
} | null {
  if (!options.isClientError) {
    return null;
  }
  if (
    assistantToolCallsNeedThoughtSignatureBackfill(params) &&
    /thought[_\s-]?signature/i.test(options.haystack)
  ) {
    return {
      kind: "missing-thought-signature",
      message:
        "Upstream requires thought signature round-trip; retrying with signatures on unsigned tool_calls",
      apply: () => {
        backfillGoogleThoughtSignatures(params, options.capturedByCallId);
      },
    };
  }
  if (
    messagesCarryGoogleThoughtSignature(params) &&
    /extra_content/i.test(options.haystack) &&
    UNKNOWN_EXTRA_CONTENT_REJECTION.test(options.haystack)
  ) {
    return {
      kind: "unknown-extra-content",
      message: "Upstream rejected tool_call extra_content; retrying without it",
      apply: () => {
        stripGoogleThoughtSignatures(params);
      },
    };
  }
  return null;
}
