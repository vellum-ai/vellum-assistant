type ThinkingConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ThinkingConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeThinkingConfigForWire(
  thinking: unknown,
): ThinkingConfigRecord | undefined {
  if (!isRecord(thinking)) return undefined;

  if (typeof thinking.type === "string") {
    return thinking;
  }

  if (thinking.enabled === true) {
    return { type: "adaptive" };
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
