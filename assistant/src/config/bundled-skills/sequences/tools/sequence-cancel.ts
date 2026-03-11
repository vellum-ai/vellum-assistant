import { exitEnrollment, getEnrollment } from "../../../../sequence/store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const enrollmentId = input.enrollment_id as string;
  if (!enrollmentId) return err("enrollment_id is required.");

  try {
    const enrollment = getEnrollment(enrollmentId);
    if (!enrollment) return err(`Enrollment not found: ${enrollmentId}`);
    if (enrollment.status !== "active" && enrollment.status !== "paused") {
      return ok(`Enrollment already in terminal state: ${enrollment.status}`);
    }

    exitEnrollment(enrollmentId, "cancelled");
    return ok(`Enrollment for ${enrollment.contactEmail} cancelled.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
