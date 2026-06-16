/**
 * Formatter helpers for the conversation LLM context inspector. Web
 * port of `MessageInspectorSummaryFormatters.swift`. Same fallback
 * sentinel ("Unavailable") and same display rules so the two surfaces
 * stay visually identical.
 */

import type { LLMCallSummary } from "@vellumai/assistant-api";

/**
 * Shared sentinel string used wherever a normalized field is absent.
 * Matches `MessageInspectorSummaryFormatters.missingValue`.
 */
export const MISSING_VALUE = "Unavailable";

const numberFormatter = new Intl.NumberFormat(undefined, { style: "decimal" });

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const RESPONSE_PREVIEW_LIMIT = 240;
const TOOL_NAME_MAX_VISIBLE = 3;

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  return numberFormatter.format(value);
}

export function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  return costFormatter.format(value);
}

/**
 * Renders a 0–1 ratio as a whole-number percentage (e.g. `0.42` → `"42%"`).
 * Returns {@link MISSING_VALUE} when the ratio is absent or non-finite.
 */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return MISSING_VALUE;
  return `${Math.round(ratio * 100)}%`;
}

export function formatCacheTokens(
  created: number | null | undefined,
  read: number | null | undefined,
): string {
  const parts: string[] = [];
  if (created != null && Number.isFinite(created)) {
    parts.push(`Created ${formatCount(created)}`);
  }
  if (read != null && Number.isFinite(read)) {
    parts.push(`Read ${formatCount(read)}`);
  }
  return parts.length ? parts.join(", ") : MISSING_VALUE;
}

export function displayText(value: string | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : MISSING_VALUE;
}

const KNOWN_PROVIDERS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

export function displayProvider(value: string | null | undefined): string {
  if (!value) return MISSING_VALUE;
  const trimmed = value.trim();
  if (!trimmed) return MISSING_VALUE;
  const lower = trimmed.toLowerCase();
  const known = KNOWN_PROVIDERS[lower];
  if (known) return known;
  const parts = lower.split(/[-_]+/).filter(Boolean);
  if (!parts.length) return trimmed;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

export function formattedCreatedAt(
  epochMs: number | null | undefined,
): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return MISSING_VALUE;
  return dateTimeFormatter.format(new Date(epochMs));
}

export function truncatedResponsePreview(
  preview: string | null | undefined,
): string {
  if (preview == null) return MISSING_VALUE;
  const trimmed = preview.trim();
  if (!trimmed) return MISSING_VALUE;
  if (trimmed.length <= RESPONSE_PREVIEW_LIMIT) return trimmed;
  const head = trimmed.slice(0, RESPONSE_PREVIEW_LIMIT).trim();
  return head ? `${head}…` : MISSING_VALUE;
}

export function compactToolNames(
  names: string[] | null | undefined,
): string {
  if (!names) return MISSING_VALUE;
  const cleaned = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (!cleaned.length) return MISSING_VALUE;
  if (cleaned.length <= TOOL_NAME_MAX_VISIBLE) return cleaned.join(", ");
  const visible = cleaned.slice(0, TOOL_NAME_MAX_VISIBLE).join(", ");
  return `${visible} +${cleaned.length - TOOL_NAME_MAX_VISIBLE} more`;
}

/**
 * `true` when the daemon attached a summary but it has nothing past the
 * provider name — a degenerate row we want to show as a fallback card
 * rather than a sea of "Unavailable" values. Mirrors macOS's
 * `isProviderOnlySummary`.
 */
export function isProviderOnlySummary(summary: LLMCallSummary): boolean {
  if (displayProvider(summary.provider) === MISSING_VALUE) return false;
  return (
    summary.model == null &&
    summary.status == null &&
    summary.inputTokens == null &&
    summary.outputTokens == null &&
    summary.cacheCreationInputTokens == null &&
    summary.cacheReadInputTokens == null &&
    summary.stopReason == null &&
    summary.requestMessageCount == null &&
    summary.requestToolCount == null &&
    summary.responseMessageCount == null &&
    summary.responseToolCallCount == null &&
    summary.responsePreview == null &&
    (!summary.toolCallNames || summary.toolCallNames.length === 0)
  );
}

export function summaryFallbackMessage(
  recordedAtEpochMs: number | null | undefined,
  provider: string | null | undefined,
): string {
  const recordedAt = formattedCreatedAt(recordedAtEpochMs);
  const providerName = provider ? displayProvider(provider) : null;
  if (providerName && providerName !== MISSING_VALUE) {
    return `Recorded at ${recordedAt} from ${providerName}. The daemon couldn't normalize a summary, but the raw request and response are still available on the Raw tab.`;
  }
  return `Recorded at ${recordedAt}. The daemon couldn't normalize a summary, but the raw request and response are still available on the Raw tab.`;
}
