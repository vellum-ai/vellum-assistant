import {
  getDashboardData,
  getStepMetrics,
} from "../../../../sequence/analytics.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id as string | undefined;

  const data = getDashboardData();

  const lines: string[] = [];

  // ── Summary ─────────────────────────────────────────────────────
  lines.push("=== Sequence Analytics Dashboard ===");
  lines.push("");
  lines.push(`Total sequences:     ${data.summary.totalSequences}`);
  lines.push(`Active sequences:    ${data.summary.activeSequences}`);
  lines.push(`Active enrollments:  ${data.summary.activeEnrollments}`);
  lines.push(`Sends today:         ${data.summary.sendsToday}`);
  lines.push(
    `Overall reply rate:  ${(data.summary.overallReplyRate * 100).toFixed(1)}%`,
  );

  // ── Per-sequence table ──────────────────────────────────────────
  if (data.sequences.length > 0) {
    lines.push("");
    lines.push("--- Per-Sequence Metrics ---");
    for (const m of data.sequences) {
      lines.push("");
      lines.push(`  ${m.sequenceName} (${m.status})`);
      lines.push(
        `    Enrolled: ${m.totalEnrollments}  Active: ${m.activeEnrollments}  Sends: ${m.sends}`,
      );
      lines.push(
        `    Replied: ${m.replies}  Completed: ${m.completions}  Failed: ${m.failures}  Cancelled: ${m.cancellations}`,
      );
      lines.push(
        `    Reply rate: ${(m.replyRate * 100).toFixed(
          1,
        )}%  Completion rate: ${(m.completionRate * 100).toFixed(1)}%`,
      );
      if (m.avgTimeToReplyMs != null) {
        const hours = Math.round(m.avgTimeToReplyMs / (1000 * 60 * 60));
        lines.push(`    Avg time to reply: ${hours}h`);
      }
    }
  }

  // ── Step funnel (if specific sequence requested) ────────────────
  if (sequenceId) {
    const steps = getStepMetrics(sequenceId);
    if (steps.length > 0) {
      lines.push("");
      lines.push("--- Step Funnel ---");
      for (const s of steps) {
        const bar = "#".repeat(
          Math.max(
            1,
            Math.round(
              (s.enrollmentsReached /
                Math.max(1, steps[0].enrollmentsReached)) *
                20,
            ),
          ),
        );
        lines.push(
          `  Step ${s.stepIndex + 1}: "${s.subject}" — ${s.sends} sends, ${
            s.enrollmentsReached
          } reached, ${(s.dropOff * 100).toFixed(0)}% drop-off`,
        );
        lines.push(`    ${bar}`);
      }
    }
  }

  // ── Recent activity ─────────────────────────────────────────────
  if (data.recentEvents.length > 0) {
    lines.push("");
    lines.push("--- Recent Activity ---");
    for (const e of data.recentEvents.slice(0, 10)) {
      const time = new Date(e.createdAt).toISOString();
      const step = e.stepIndex !== undefined ? ` step ${e.stepIndex + 1}` : "";
      lines.push(
        `  [${time}] ${e.eventType}${step} — enrollment ${e.enrollmentId.slice(
          0,
          8,
        )}...`,
      );
    }
  }

  return ok(lines.join("\n"));
}
