import { THINKING_LEVELS, type ThinkingLevel } from "../config/schemas/llm.js";

type ThinkingConfigRecord = Record<string, unknown>;

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

function isRecord(value: unknown): value is ThinkingConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickGeminiExtras(thinking: ThinkingConfigRecord): {
  level?: ThinkingLevel;
  streamThinking?: boolean;
} {
  const extras: { level?: ThinkingLevel; streamThinking?: boolean } = {};
  if (
    typeof thinking.level === "string" &&
    THINKING_LEVEL_SET.has(thinking.level)
  ) {
    extras.level = thinking.level as ThinkingLevel;
  }
  if (typeof thinking.streamThinking === "boolean") {
    extras.streamThinking = thinking.streamThinking;
  }
  return extras;
}

export function normalizeThinkingConfigForWire(
  thinking: unknown,
): ThinkingConfigRecord | undefined {
  if (!isRecord(thinking)) return undefined;

  // Already in wire shape — preserve as-is so re-normalization is idempotent
  // and Gemini-only fields stay attached for the Gemini provider to read.
  if (typeof thinking.type === "string") {
    return thinking;
  }

  const extras = pickGeminiExtras(thinking);

  if (thinking.enabled === true) {
    return { type: "adaptive", ...extras };
  }

  if (thinking.enabled === false) {
    return { type: "disabled" };
  }

  return undefined;
}

export function isThinkingConfigDisabled(thinking: unknown): boolean {
  return normalizeThinkingConfigForWire(thinking)?.type === "disabled";
}

export function isThinkingConfigEnabled(thinking: unknown): boolean {
  const normalized = normalizeThinkingConfigForWire(thinking);
  return normalized !== undefined && normalized.type !== "disabled";
}
