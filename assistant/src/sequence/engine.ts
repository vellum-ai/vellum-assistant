/**
 * Sequence engine — processes due enrollments on each scheduler tick.
 *
 * Runs as a phase in the scheduler's 15-second tick loop. Claims due
 * enrollments, generates personalized content via the assistant, and
 * sends through the messaging layer.
 */

import { getLogger } from '../util/logger.js';
import { createConversation } from '../memory/conversation-store.js';
import { GENERATING_TITLE, queueGenerateConversationTitle } from '../memory/conversation-title-service.js';
import type { ScheduleMessageProcessor } from '../schedule/scheduler.js';
import {
  claimDueEnrollments,
  advanceEnrollment,
  exitEnrollment,
  getSequence,
  rescheduleEnrollment,
} from './store.js';
import type { Sequence, SequenceEnrollment, SequenceStep } from './types.js';

const log = getLogger('sequence-engine');

const MAX_RETRIES = 3;
const BATCH_SIZE = 10;

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
        'Sequence enrollment processing failed',
      );
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
    log.warn({ enrollmentId: enrollment.id, sequenceId: enrollment.sequenceId }, 'Sequence not found, cancelling enrollment');
    exitEnrollment(enrollment.id, 'failed');
    return;
  }

  if (sequence.status !== 'active') {
    log.info({ enrollmentId: enrollment.id, sequenceId: enrollment.sequenceId, status: sequence.status }, 'Sequence not active, skipping');
    // Re-set nextStepAt so it can be picked up when the sequence resumes
    advanceEnrollmentToCurrentStep(enrollment, sequence);
    return;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    log.info({ enrollmentId: enrollment.id, step: enrollment.currentStep }, 'No more steps, marking completed');
    exitEnrollment(enrollment.id, 'completed');
    return;
  }

  // Build the prompt for the assistant to generate and send the email
  const prompt = buildStepPrompt(enrollment, sequence, step);

  // Create a conversation for this step execution
  const conversation = createConversation({ title: GENERATING_TITLE, source: 'sequence' });
  queueGenerateConversationTitle({
    conversationId: conversation.id,
    context: { origin: 'sequence', systemHint: `Sequence: ${sequence.name} — Step ${step.index + 1}` },
  });

  log.info({
    enrollmentId: enrollment.id,
    sequenceId: sequence.id,
    step: step.index,
    contactEmail: enrollment.contactEmail,
    conversationId: conversation.id,
  }, 'Processing sequence step');

  await processMessage(conversation.id, prompt);

  // Advance to the next step
  const nextStepIndex = enrollment.currentStep + 1;
  if (nextStepIndex >= sequence.steps.length) {
    // This was the final step
    advanceEnrollment(enrollment.id, undefined, null);
    exitEnrollment(enrollment.id, 'completed');
    log.info({ enrollmentId: enrollment.id, sequenceId: sequence.id }, 'Sequence completed');
  } else {
    const nextStep = sequence.steps[nextStepIndex];
    const nextStepAt = Date.now() + (nextStep.delaySeconds * 1000);
    advanceEnrollment(enrollment.id, undefined, nextStepAt);
    log.info({
      enrollmentId: enrollment.id,
      nextStep: nextStepIndex,
      nextStepAt: new Date(nextStepAt).toISOString(),
    }, 'Advanced to next step');
  }
}

function buildStepPrompt(
  enrollment: SequenceEnrollment,
  sequence: Sequence,
  step: SequenceStep,
): string {
  const parts: string[] = [];

  parts.push(`You are executing step ${step.index + 1} of ${sequence.steps.length} in the "${sequence.name}" email sequence.`);
  parts.push('');
  parts.push(`Recipient: ${enrollment.contactEmail}${enrollment.contactName ? ` (${enrollment.contactName})` : ''}`);
  parts.push(`Channel: ${sequence.channel}`);

  if (enrollment.context) {
    parts.push('');
    parts.push('Contact context:');
    for (const [key, value] of Object.entries(enrollment.context)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  parts.push('');

  if (step.requireApproval) {
    parts.push(`Create a DRAFT email (do not send) with subject "${step.subjectTemplate}".`);
    parts.push('The user will review and approve before sending.');
  } else {
    parts.push(`Send an email with subject "${step.subjectTemplate}".`);
  }

  if (step.replyToThread && enrollment.threadId) {
    parts.push(`Reply in the existing thread (thread ID: ${enrollment.threadId}).`);
  }

  parts.push('');
  parts.push('Content instructions:');
  parts.push(step.bodyPrompt);

  return parts.join('\n');
}

/** Re-schedule the enrollment for the current step (used when sequence is paused). */
function advanceEnrollmentToCurrentStep(
  enrollment: SequenceEnrollment,
  _sequence: Sequence,
): void {
  // Re-schedule 60 seconds from now so it gets picked up after the sequence resumes
  rescheduleEnrollment(enrollment.id, Date.now() + 60_000);
}
