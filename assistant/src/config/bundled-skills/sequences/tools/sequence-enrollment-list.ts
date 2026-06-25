import { listEnrollments } from "../../../../sequence/store.js";
import type { EnrollmentStatus } from "../../../../sequence/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id as string | undefined;
  const status = input.status as EnrollmentStatus | undefined;

  try {
    const enrollments = listEnrollments({ sequenceId, status });
    if (enrollments.length === 0) return ok("No enrollments found.");

    const lines = enrollments.map((e) => {
      const nextAt = e.nextStepAt
        ? new Date(e.nextStepAt).toISOString()
        : "n/a";
      return `- ${e.contactEmail} (ID: ${e.id}) - step ${e.currentStep}, status: ${e.status}, next: ${nextAt}`;
    });
    return ok(`${enrollments.length} enrollment(s):\n${lines.join("\n")}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
