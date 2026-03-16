import {
  exitEnrollment,
  getEnrollment,
  getSequence,
  pauseEnrollment,
  resumeEnrollment,
  updateSequence,
} from "../../../../sequence/store.js";
import type {
  SequenceStatus,
  SequenceStep,
} from "../../../../sequence/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string | undefined;
  const enrollmentId = input.enrollment_id as string | undefined;
  const enrollmentAction = input.enrollment_action as string | undefined;

  // ── Enrollment-level lifecycle actions ──────────────────────────────
  if (enrollmentId) {
    if (!enrollmentAction)
      return err(
        "enrollment_action is required when enrollment_id is provided.",
      );

    try {
      const enrollment = getEnrollment(enrollmentId);
      if (!enrollment) return err(`Enrollment not found: ${enrollmentId}`);

      switch (enrollmentAction) {
        case "pause": {
          if (enrollment.status !== "active")
            return err(
              `Enrollment is not active (status: ${enrollment.status}).`,
            );
          pauseEnrollment(enrollmentId);
          return ok(
            `Enrollment ${enrollmentId} paused. Resume it later to continue from step ${
              enrollment.currentStep + 1
            }.`,
          );
        }
        case "resume": {
          if (enrollment.status !== "paused")
            return err(
              `Enrollment is not paused (status: ${enrollment.status}).`,
            );
          const seq = enrollment.sequenceId
            ? getSequence(enrollment.sequenceId)
            : null;
          if (seq && seq.status !== "active")
            return err(
              `Cannot resume enrollment — parent sequence "${seq.name}" is ${seq.status}. Resume the sequence first.`,
            );
          resumeEnrollment(enrollmentId);
          return ok(`Enrollment ${enrollmentId} resumed.`);
        }
        case "cancel": {
          if (
            enrollment.status !== "active" &&
            enrollment.status !== "paused"
          ) {
            return ok(
              `Enrollment already in terminal state: ${enrollment.status}`,
            );
          }
          exitEnrollment(enrollmentId, "cancelled");
          return ok(`Enrollment for ${enrollment.contactEmail} cancelled.`);
        }
        default:
          return err(
            `Unknown enrollment_action: "${enrollmentAction}". Use "pause", "resume", or "cancel".`,
          );
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Sequence-level update ──────────────────────────────────────────
  if (!id) return err("id is required.");

  const name = input.name as string | undefined;
  const description = input.description as string | undefined;
  const status = input.status as SequenceStatus | undefined;
  const exitOnReply = input.exit_on_reply as boolean | undefined;
  const stepsRaw = input.steps as Array<Record<string, unknown>> | undefined;

  try {
    const steps = stepsRaw?.map(
      (s, i): SequenceStep => ({
        index: i,
        delaySeconds: (s.delay_seconds as number) ?? 0,
        subjectTemplate: (s.subject as string) ?? `Step ${i + 1}`,
        bodyPrompt: (s.body_prompt as string) ?? "",
        replyInSameConversation:
          (s.reply_in_same_conversation as boolean) ?? i > 0,
        requireApproval: (s.require_approval as boolean) ?? false,
      }),
    );

    if (steps !== undefined && steps.length === 0) {
      return err(
        "steps must not be empty. A sequence requires at least one step.",
      );
    }

    const updated = updateSequence(id, {
      name,
      description,
      status,
      exitOnReply,
      steps,
    });
    if (!updated) return err(`Sequence not found: ${id}`);

    return ok(`Sequence updated: ${updated.name} (${updated.status})`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
