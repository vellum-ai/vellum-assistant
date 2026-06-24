import type { AgentEvent } from "./adapter";
import type { CostDiagnostic, CostStatus, UsageSummary } from "./metrics";
import { priceUsageRecord } from "./pricing";

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Reduce an assistant-events stream into a single per-run `UsageSummary`.
 *
 * Beyond the token sum it owned before, this function also runs each
 * usage record through `priceUsageRecord` (local evals pricing table) to
 * populate `totalCostUsd`. Round-3 evals feedback flagged the report's
 * cost cell as stuck at "—" because cost was never computed; the new
 * `costStatus` + `costDiagnostics` fields explain "why" when a record
 * can't be priced (missing provider/model, unknown model, no token
 * counts), so the report surfaces actionable information instead of a
 * silent zero.
 *
 * The summarizer is best-effort: a missing field on a single record
 * never aborts the whole summary. Unpriceable rows produce diagnostics
 * and don't contribute to `totalCostUsd`; priceable rows still sum
 * correctly alongside them.
 */
export function summarizeAssistantUsage(events: AgentEvent[]): UsageSummary {
  const requests: Array<Record<string, unknown>> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sawTokens = false;

  let totalCostUsd = 0;
  let pricedRequestCount = 0;
  const costDiagnostics: CostDiagnostic[] = [];

  for (const event of events) {
    const usage = event.message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const record = usage as Record<string, unknown>;
    // Harness grading traffic (the LLM judge, tagged `origin: "metric"` by
    // the runner) is not assistant model spend — exclude it from the
    // per-request breakdown, token totals, and `totalCostUsd` so the Cost
    // tab reflects only what the agent itself spent. A metric record is
    // dropped entirely here; if grading cost ever needs to surface, it
    // should do so in its own section, never folded into the agent's bill.
    if (record.origin === "metric") continue;
    const requestIndex = requests.length;
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

    const priced = priceUsageRecord(record);
    if (priced.costUsd !== undefined) {
      totalCostUsd += priced.costUsd;
      pricedRequestCount += 1;
    } else if (priced.diagnostic) {
      costDiagnostics.push({ requestIndex, ...priced.diagnostic });
    }
  }

  const costStatus = computeCostStatus({
    requestCount: requests.length,
    pricedRequestCount,
  });

  return {
    requests,
    ...(sawTokens ? { totalInputTokens, totalOutputTokens } : {}),
    ...(pricedRequestCount > 0 ? { totalCostUsd } : {}),
    costStatus,
    ...(costDiagnostics.length > 0 ? { costDiagnostics } : {}),
  };
}

function computeCostStatus(input: {
  requestCount: number;
  pricedRequestCount: number;
}): CostStatus {
  if (input.requestCount === 0) return "missing";
  if (input.pricedRequestCount === 0) return "missing";
  if (input.pricedRequestCount < input.requestCount) return "partial";
  return "ok";
}

export function mergeUsageSummaries(
  ...summaries: UsageSummary[]
): UsageSummary {
  const events = summaries.flatMap((summary) =>
    summary.requests.map((usage) => ({ message: { type: "usage", usage } })),
  );
  return summarizeAssistantUsage(events);
}
