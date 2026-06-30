/**
 * Text rendering for `assistant memory v2 compare` — turns a
 * `ComparisonReport` (the daemon route's response) into a human-readable
 * summary and a per-turn breakdown.
 *
 * Lives CLI-side because formatting for the terminal is a presentation concern
 * (mirroring the inline rendering in the `simulate` subcommand). It imports
 * only the response *type* from the daemon — `cli/no-daemon-internals` permits
 * type-only imports but forbids pulling in daemon runtime modules.
 */

import type { ComparisonReport } from "../../../plugins/defaults/memory/v2/harness/runner.js";

function sortedKs(report: ComparisonReport): number[] {
  return [...report.ks].sort((a, b) => a - b);
}

/** Sum per-lane hit counts across every scored turn for one retriever. */
function laneTotals(
  report: ComparisonReport,
  retrieverName: string,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const turn of report.perTurn) {
    const ev = turn.byRetriever[retrieverName];
    if (!ev) continue;
    for (const [lane, count] of Object.entries(ev.hitsByLane)) {
      totals[lane] = (totals[lane] ?? 0) + count;
    }
  }
  return totals;
}

export function renderComparisonReport(report: ComparisonReport): string {
  const ks = sortedKs(report);
  const lines: string[] = [
    "Memory Retrieval Comparison",
    "===========================",
    `Turns: considered ${report.turnsConsidered}, scored ${report.turnsScored}, skipped ${report.turnsSkipped}`,
    `recall@k cutoffs: ${ks.join(", ")}`,
    "",
  ];

  if (report.turnsScored === 0) {
    lines.push(
      "No turns scored — nothing to report.",
      "(Every sampled turn was skipped — e.g. input reconstruction failed, or none matched the filter.)",
    );
    return lines.join("\n");
  }

  for (const retriever of report.retrievers) {
    lines.push(`Retriever: ${retriever.name}`);
    for (const k of ks) {
      const value = retriever.aggregate.meanRecallAtK[k];
      lines.push(
        `  recall@${k}: ${value !== undefined ? value.toFixed(3) : "n/a"}`,
      );
    }
    lines.push(
      `  failures: ${(retriever.aggregate.failureRate * 100).toFixed(1)}%`,
    );
    if (retriever.aggregate.meanCostUsd !== undefined) {
      lines.push(`  mean cost: $${retriever.aggregate.meanCostUsd.toFixed(4)}`);
    }
    const lanes = Object.entries(laneTotals(report, retriever.name)).sort(
      (a, b) => b[1] - a[1],
    );
    const laneStr = lanes.map(([lane, count]) => `${lane}=${count}`).join(", ");
    lines.push(`  hits by lane: ${laneStr.length > 0 ? laneStr : "(none)"}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderTurnTrace(
  report: ComparisonReport,
  conversationId: string,
  turn: number,
): string {
  const entry = report.perTurn.find(
    (t) => t.conversationId === conversationId && t.turn === turn,
  );
  if (!entry) {
    return (
      `Turn ${conversationId}:${turn} not found in the report. Only scored ` +
      `turns appear here — skipped turns (e.g. failed input reconstruction) ` +
      `are excluded. turnsScored=${report.turnsScored}, ` +
      `turnsSkipped=${report.turnsSkipped}.`
    );
  }

  const ks = sortedKs(report);
  const header = `Turn ${conversationId}:${turn}`;
  const lines: string[] = [header, "-".repeat(header.length)];

  for (const [name, ev] of Object.entries(entry.byRetriever)) {
    const recallStr = ks
      .map((k) => `${k}:${(ev.recallAtK[k] ?? 0).toFixed(3)}`)
      .join("  ");
    lines.push(
      `Retriever: ${name}`,
      `  selected (${ev.selected.length}): ${ev.selected.join(", ") || "(none)"}`,
      `  hits (${ev.hits.length}): ${ev.hits.join(", ") || "(none)"}`,
      `  misses (${ev.misses.length}): ${ev.misses.join(", ") || "(none)"}`,
      `  extras (${ev.extras.length}): ${ev.extras.join(", ") || "(none)"}`,
      `  recall@k: ${recallStr}`,
      "  (no descent trace — tier-based retriever)",
      "",
    );
  }

  return lines.join("\n").trimEnd();
}
