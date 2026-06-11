// ---------------------------------------------------------------------------
// Recall-Decision Gate — report script
//
// Reads the memory_recall_gate_decisions log table and prints a markdown
// report to stdout:
//   - Skip-rate by rule
//   - Latency saved (shadow mode: measured; live: projected)
//   - Sample decisions for manual review
//   - Drift over time (daily buckets)
//
// Usage (from assistant/):
//   bun run scripts/recall-gate-report.ts
//   bun run scripts/recall-gate-report.ts --limit 500
//   bun run scripts/recall-gate-report.ts --days 7
// ---------------------------------------------------------------------------

import { getSqlite } from "../src/memory/db-connection.js";
import { initializeDb } from "../src/memory/db-init.js";

initializeDb();
const db = getSqlite();

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit =
  limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "10000", 10) : 10000;
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? "30", 10) : 30;

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  conversation_id: string;
  turn: number;
  timestamp: number;
  decision: string;
  rule_fired: string | null;
  safety_floor_hit: number;
  safety_floor_tokens: string | null;
  redacted_user_text: string | null;
  prompt_char_count: number;
  prompt_token_estimate: number;
  has_entities: number;
  has_question_mark: number;
  decision_latency_us: number;
  mode: string;
  retrieval_latency_ms: number | null;
  v3_selector_result: string | null;
}

const rows = db
  .query<Row, [number, number]>(
    /*sql*/ `
  SELECT * FROM memory_recall_gate_decisions
  WHERE timestamp >= ?1
  ORDER BY timestamp DESC
  LIMIT ?2
`,
  )
  .all(cutoff, limit);

if (rows.length === 0) {
  console.log("# Recall-Gate Report\n\nNo decisions logged yet.\n");
  process.exit(0);
}

// --- Aggregate ---
const total = rows.length;
const skips = rows.filter((r) => r.decision === "skip");
const retrieves = rows.filter((r) => r.decision === "retrieve");
const skipRate = ((skips.length / total) * 100).toFixed(1);

const ruleBreakdown = new Map<string, number>();
for (const r of rows) {
  const key = r.rule_fired ?? "(default-retrieve)";
  ruleBreakdown.set(key, (ruleBreakdown.get(key) ?? 0) + 1);
}

const safetyFloorCount = rows.filter((r) => r.safety_floor_hit === 1).length;

// Latency analysis (shadow mode: measured retrieval_latency_ms)
const shadowRows = rows.filter(
  (r) => r.mode === "shadow" && r.retrieval_latency_ms !== null,
);
const shadowSkipRows = shadowRows.filter((r) => r.decision === "skip");
const avgRetrievalMs =
  shadowRows.length > 0
    ? shadowRows.reduce((s, r) => s + r.retrieval_latency_ms!, 0) /
      shadowRows.length
    : 0;
const latencySavedMs =
  shadowSkipRows.length > 0
    ? shadowSkipRows.reduce((s, r) => s + r.retrieval_latency_ms!, 0)
    : 0;

// Daily drift
const dailyBuckets = new Map<string, { total: number; skips: number }>();
for (const r of rows) {
  const day = new Date(r.timestamp).toISOString().slice(0, 10);
  const bucket = dailyBuckets.get(day) ?? { total: 0, skips: 0 };
  bucket.total++;
  if (r.decision === "skip") bucket.skips++;
  dailyBuckets.set(day, bucket);
}

// Sample decisions
const sampleSkips = skips.slice(0, 10);
const sampleRetrieves = retrieves.slice(0, 5);

// --- Output ---
const lines: string[] = [];
function out(s: string) {
  lines.push(s);
}

out("# Recall-Decision Gate — Report");
out("");
out(
  `Period: last ${days} days | Rows: ${total} | Generated: ${new Date().toISOString()}`,
);
out("");

out("## Overall Skip Rate");
out("");
out(`| Metric | Value |`);
out(`|--------|-------|`);
out(`| Total decisions | ${total} |`);
out(`| Skips | ${skips.length} (${skipRate}%) |`);
out(`| Retrieves | ${retrieves.length} |`);
out(`| Safety floor overrides | ${safetyFloorCount} |`);
out("");

out("## Skip Rate by Rule");
out("");
out(`| Rule | Count | % of Total |`);
out(`|------|-------|------------|`);
for (const [rule, count] of [...ruleBreakdown.entries()].sort(
  (a, b) => b[1] - a[1],
)) {
  out(`| ${rule} | ${count} | ${((count / total) * 100).toFixed(1)}% |`);
}
out("");

out("## Latency Analysis (Shadow Mode)");
out("");
out(`| Metric | Value |`);
out(`|--------|-------|`);
out(`| Shadow rows with measured latency | ${shadowRows.length} |`);
out(`| Avg retrieval latency (all shadow) | ${avgRetrievalMs.toFixed(0)} ms |`);
out(
  `| Total latency saved (would-skip turns) | ${latencySavedMs.toFixed(0)} ms |`,
);
out(`| Would-skip turns | ${shadowSkipRows.length} |`);
out("");

out("## Drift Over Time");
out("");
out(`| Date | Total | Skips | Skip Rate |`);
out(`|------|-------|-------|-----------|`);
for (const [day, bucket] of [...dailyBuckets.entries()].sort()) {
  const rate = ((bucket.skips / bucket.total) * 100).toFixed(1);
  out(`| ${day} | ${bucket.total} | ${bucket.skips} | ${rate}% |`);
}
out("");

out("## Judge Eval (stub)");
out("");
out(
  "_Judge evaluation is not yet implemented. This section will compare skip decisions against an LLM-judge's retrieval-necessity labels._",
);
out("");

out("## Sample Skip Decisions");
out("");
for (const r of sampleSkips) {
  out(
    `- **${r.rule_fired}** | conv=${r.conversation_id.slice(0, 8)}… turn=${r.turn} | "${r.redacted_user_text?.slice(0, 60) ?? ""}"`,
  );
}
out("");

out("## Sample Retrieve Decisions");
out("");
for (const r of sampleRetrieves) {
  out(
    `- **${r.rule_fired ?? "(default)"}** | conv=${r.conversation_id.slice(0, 8)}… turn=${r.turn} | "${r.redacted_user_text?.slice(0, 60) ?? ""}"`,
  );
}
out("");

console.log(lines.join("\n"));
