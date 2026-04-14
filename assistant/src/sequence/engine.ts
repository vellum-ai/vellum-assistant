/**
 * Sequence engine — processes due enrollments on each scheduler tick.
 *
 * Runs as a phase in the scheduler's 15-second tick loop. Claims due
 * enrollments, generates personalized content via the assistant, and
 * sends through the messaging layer.
 */

import { emitFeedEvent } from "../home/emit-feed-event.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { getMessages } from "../memory/conversation-crud.js";
import type { ScheduleMessageProcessor } from "../schedule/scheduler.js";
import { getLogger } from "../util/logger.js";
import { recordEvent } from "./analytics.js";
import { checkAllPreSend, recordSend } from "./guardrails.js";
import {
  advanceEnrollment,
  claimDueEnrollments,
  exitEnrollment,
  getEnrollment,
  getSequence,
  rescheduleEnrollment,
  updateEnrollmentConversationId,
} from "./store.js";
import type { Sequence, SequenceEnrollment, SequenceStep } from "./types.js";

const log = getLogger("sequence-engine");

const BATCH_SIZE = 10;
const ERROR_RETRY_DELAY_MS = 60_000;

/**
 * Process due sequence enrollments. Called by the scheduler on each tick.
 * Returns the number of enrollments processed.
 */
export async function runSequencesOnce(
  processMessage: ScheduleMessageProcessor,
): Promise<number> {
  const now = Date.now();
  const claimed = claimDueEnrollments(now, BATCH_SIZE);
  if (claimed.length === 0) return 0;

  let processed = 0;
  for (const enrollment of claimed) {
    try {
      await processEnrollment(enrollment, processMessage);
      processed += 1;
    } catch (err) {
      log.error(
        { err, enrollmentId: enrollment.id, sequenceId: enrollment.sequenceId },
        "Sequence enrollment processing failed",
      );
      // Reschedule so the enrollment is retryable. claimDueEnrollments nulled
      // nextStepAt to prevent concurrent claims; without restoring it the
      // enrollment would be stranded as active with nextStepAt = null forever.
      try {
        const current = getEnrollment(enrollment.id);
        if (current && current.status === "active") {
          rescheduleEnrollment(
            enrollment.id,
            Date.now() + ERROR_RETRY_DELAY_MS,
          );
          log.info(
            {
              enrollmentId: enrollment.id,
              retryAt: new Date(
                Date.now() + ERROR_RETRY_DELAY_MS,
              ).toISOString(),
            },
            "Rescheduled enrollment for retry after processing failure",
          );
        }
      } catch (rescheduleErr) {
        log.error(
          { err: rescheduleErr, enrollmentId: enrollment.id },
          "Failed to reschedule enrollment after processing failure",
        );
      }
    }
  }
  return processed;
}

async function processEnrollment(
  enrollment: SequenceEnrollment,
  processMessage: ScheduleMessageProcessor,
): Promise<void> {
  const sequence = getSequence(enrollment.sequenceId);
  if (!sequence) {
    log.warn(
      { enrollmentId: enrollment.id, sequenceId: enrollment.sequenceId },
      "Sequence not found, cancelling enrollment",
    );
    recordEvent(enrollment.sequenceId, enrollment.id, "fail", undefined, {
      reason: "sequence_not_found",
    });
    exitEnrollment(enrollment.id, "failed");
    return;
  }

  if (sequence.status !== "active") {
    log.info(
      {
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequenceId,
        status: sequence.status,
      },
      "Sequence not active, skipping",
    );
    // Re-set nextStepAt so it can be picked up when the sequence resumes
    advanceEnrollmentToCurrentStep(enrollment, sequence);
    return;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    log.info(
      { enrollmentId: enrollment.id, step: enrollment.currentStep },
      "No more steps, marking completed",
    );
    recordEvent(sequence.id, enrollment.id, "complete");
    exitEnrollment(enrollment.id, "completed");
    return;
  }

  // Enforce guardrails before allocating resources for the send
  const guardrailResult = checkAllPreSend(
    sequence.id,
    enrollment,
    step.delaySeconds,
  );
  if (!guardrailResult.ok) {
    log.info(
      {
        enrollmentId: enrollment.id,
        sequenceId: sequence.id,
        guardrail: guardrailResult.guardrail,
        reason: guardrailResult.reason,
      },
      "Guardrail blocked sequence step — rescheduling",
    );
    rescheduleEnrollment(enrollment.id, Date.now() + ERROR_RETRY_DELAY_MS);
    return;
  }

  // Build the prompt for the assistant to generate and send the email
  const prompt = buildStepPrompt(enrollment, sequence, step);

  // Create a conversation for this step execution
  const conversation = bootstrapConversation({
    source: "sequence",
    origin: "sequence",
    systemHint: `Sequence: ${sequence.name} — Step ${step.index + 1}`,
  });

  log.info(
    {
      enrollmentId: enrollment.id,
      sequenceId: sequence.id,
      step: step.index,
      contactEmail: enrollment.contactEmail,
      conversationId: conversation.id,
    },
    "Processing sequence step",
  );

  await processMessage(conversation.id, prompt);

  // Try to extract the email thread ID from conversation tool results so
  // subsequent steps can reply in the same conversation.
  const extractedConversationId =
    extractThreadIdFromConversation(conversation.id) ?? undefined;
  if (extractedConversationId) {
    log.info(
      { enrollmentId: enrollment.id, conversationId: extractedConversationId },
      "Captured conversation ID from step execution",
    );
  }

  // Steps that require approval create a draft instead of sending. Don't
  // advance the enrollment — leave it at the current step with nextStepAt
  // null so it won't be re-claimed. The approval/send flow is responsible
  // for advancing the enrollment once the draft is approved.
  if (step.requireApproval) {
    if (extractedConversationId)
      updateEnrollmentConversationId(enrollment.id, extractedConversationId);
    log.info(
      {
        enrollmentId: enrollment.id,
        sequenceId: sequence.id,
        step: step.index,
      },
      "Step requires approval — pausing advancement until draft is approved",
    );
    return;
  }

  // Track the send for rate-limiting guardrails and analytics.
  // Placed after the requireApproval gate so draft-only steps don't inflate
  // rate-limit counters — only actual sends are counted.
  recordSend(sequence.id);
  recordEvent(sequence.id, enrollment.id, "send", step.index);

  // Fire-and-forget home-feed activity log entry. Each (enrollment,
  // step) pair is a distinct real signal (an email actually went
  // out), so the dedupKey embeds both — repeat emits for the same
  // step are impossible because the enrollment advances after this
  // line, but if they did occur they'd land on the same entry.
  void emitFeedEvent({
    source: "assistant",
    title: sequence.name,
    summary: `Sent step ${step.index + 1} of ${sequence.steps.length} to ${enrollment.contactEmail}.`,
    dedupKey: `sequence-step:${enrollment.id}:${step.index}`,
  }).catch((err) => {
    log.warn(
      {
        err,
        sequenceId: sequence.id,
        enrollmentId: enrollment.id,
        step: step.index,
      },
      "Failed to emit sequence step feed event",
    );
  });

  // Advance to the next step
  const nextStepIndex = enrollment.currentStep + 1;
  if (nextStepIndex >= sequence.steps.length) {
    // This was the final step
    advanceEnrollment(enrollment.id, extractedConversationId, null);
    recordEvent(sequence.id, enrollment.id, "complete", step.index);
    exitEnrollment(enrollment.id, "completed");
    log.info(
      { enrollmentId: enrollment.id, sequenceId: sequence.id },
      "Sequence completed",
    );
  } else {
    const nextStep = sequence.steps[nextStepIndex];
    const nextStepAt = Date.now() + nextStep.delaySeconds * 1000;
    advanceEnrollment(enrollment.id, extractedConversationId, nextStepAt);
    log.info(
      {
        enrollmentId: enrollment.id,
        nextStep: nextStepIndex,
        nextStepAt: new Date(nextStepAt).toISOString(),
      },
      "Advanced to next step",
    );
  }
}

function buildStepPrompt(
  enrollment: SequenceEnrollment,
  sequence: Sequence,
  step: SequenceStep,
): string {
  const parts: string[] = [];

  parts.push(
    `You are executing step ${step.index + 1} of ${
      sequence.steps.length
    } in the "${sequence.name}" email sequence.`,
  );
  parts.push("");
  parts.push(
    `Recipient: ${enrollment.contactEmail}${
      enrollment.contactName ? ` (${enrollment.contactName})` : ""
    }`,
  );
  parts.push(`Channel: ${sequence.channel}`);

  if (enrollment.context) {
    parts.push("");
    parts.push("Contact context:");
    for (const [key, value] of Object.entries(enrollment.context)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  parts.push("");

  if (step.requireApproval) {
    parts.push(
      `Create a DRAFT email (do not send) with subject "${step.subjectTemplate}".`,
    );
    parts.push("The user will review and approve before sending.");
  } else {
    parts.push(`Send an email with subject "${step.subjectTemplate}".`);
  }

  if (step.replyInSameConversation && enrollment.conversationId) {
    parts.push(
      `Reply in the existing conversation (conversation ID: ${enrollment.conversationId}).`,
    );
  }

  parts.push("");
  parts.push("Content instructions:");
  parts.push(step.bodyPrompt);

  return parts.join("\n");
}

/** Re-schedule the enrollment for the current step (used when sequence is paused). */
function advanceEnrollmentToCurrentStep(
  enrollment: SequenceEnrollment,
  _sequence: Sequence,
): void {
  // Re-schedule 60 seconds from now so it gets picked up after the sequence resumes
  rescheduleEnrollment(enrollment.id, Date.now() + 60_000);
}

/**
 * Scan conversation messages for an email thread ID returned by tool
 * invocations. Looks for common patterns like "thread_id": "..." or
 * "Thread ID: ..." in tool result text.
 */
function extractThreadIdFromConversation(
  conversationId: string,
): string | null {
  try {
    const msgs = getMessages(conversationId);
    // Walk messages in reverse — the thread ID from the most recent tool call
    // is the one we want.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      const threadId = extractThreadIdFromContent(msg.content);
      if (threadId) return threadId;
    }
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to extract thread ID from conversation",
    );
  }
  return null;
}

/** Extract a thread ID from raw message content (may be JSON content blocks or plain text). */
function extractThreadIdFromContent(content: string): string | null {
  // Pattern 1: JSON field like "threadId": "..." or "thread_id": "..."
  const jsonMatch = content.match(/"(?:threadId|thread_id)"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];

  // Pattern 2: Prose like "Thread ID: <id>" (from tool result text)
  const proseMatch = content.match(/[Tt]hread\s+(?:ID|id):\s*(\S+)/);
  if (proseMatch) return proseMatch[1];

  return null;
}
