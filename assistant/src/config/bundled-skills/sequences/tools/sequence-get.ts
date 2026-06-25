import {
  countActiveEnrollments,
  getSequence,
  listEnrollments,
} from "../../../../sequence/store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string;
  if (!id) return err("id is required.");

  try {
    const seq = getSequence(id);
    if (!seq) return err(`Sequence not found: ${id}`);

    const activeCount = countActiveEnrollments(id);
    const allEnrollments = listEnrollments({ sequenceId: id });
    const statusCounts = allEnrollments.reduce(
      (acc, e) => {
        acc[e.status] = (acc[e.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const lines = [
      `Name: ${seq.name}`,
      `ID: ${seq.id}`,
      `Status: ${seq.status}`,
      `Channel: ${seq.channel}`,
      `Exit on reply: ${seq.exitOnReply}`,
      seq.description ? `Description: ${seq.description}` : null,
      "",
      `Steps (${seq.steps.length}):`,
      ...seq.steps.map(
        (s) =>
          `  ${s.index + 1}. "${s.subjectTemplate}" - delay: ${
            s.delaySeconds
          }s${s.requireApproval ? " [approval required]" : ""}`,
      ),
      "",
      `Enrollments: ${allEnrollments.length} total, ${activeCount} active`,
      ...Object.entries(statusCounts).map(([k, v]) => `  ${k}: ${v}`),
    ].filter((line): line is string => line != null);

    return ok(lines.join("\n"));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
