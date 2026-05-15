import type { AgentEvent } from "./adapter";
import type { UsageSummary } from "./metrics";

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function summarizeAssistantUsage(events: AgentEvent[]): UsageSummary {
  const requests: Array<Record<string, unknown>> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sawTokens = false;

  for (const event of events) {
    const usage = event.message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const record = usage as Record<string, unknown>;
    requests.push(record);

    const inputTokens = numberField(record.input_tokens ?? record.inputTokens);
    const outputTokens = numberField(
      record.output_tokens ?? record.outputTokens,
    );
    if (inputTokens !== undefined) {
      totalInputTokens += inputTokens;
      sawTokens = true;
    }
    if (outputTokens !== undefined) {
      totalOutputTokens += outputTokens;
      sawTokens = true;
    }
  }

  return {
    requests,
    ...(sawTokens ? { totalInputTokens, totalOutputTokens } : {}),
  };
}
