import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { updateSequence, getSequence, getEnrollment, exitEnrollment } from '../../../../sequence/store.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id as string | undefined;
  const enrollmentId = input.enrollment_id as string | undefined;

  if (!sequenceId && !enrollmentId) return err('Either sequence_id or enrollment_id is required.');

  try {
    if (enrollmentId) {
      const enrollment = getEnrollment(enrollmentId);
      if (!enrollment) return err(`Enrollment not found: ${enrollmentId}`);
      if (enrollment.status !== 'active') return err(`Enrollment is not active (status: ${enrollment.status}).`);
      exitEnrollment(enrollmentId, 'cancelled');
      return ok(`Enrollment ${enrollmentId} paused (status set to cancelled).`);
    }

    const seq = getSequence(sequenceId!);
    if (!seq) return err(`Sequence not found: ${sequenceId}`);
    if (seq.status === 'paused') return ok('Sequence is already paused.');

    updateSequence(sequenceId!, { status: 'paused' });
    return ok(`Sequence "${seq.name}" paused. Active enrollments will not be processed until resumed.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
