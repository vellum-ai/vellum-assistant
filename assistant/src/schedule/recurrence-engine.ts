import { Cron } from 'croner';
import { rrulestr } from 'rrule';
import type { ScheduleSyntax } from './recurrence-types.js';

export interface ScheduleSpec {
  syntax: ScheduleSyntax;
  expression: string;
  timezone?: string | null;
}

/**
 * Validate a schedule expression. Returns true if the expression is valid
 * for the given syntax, false otherwise.
 */
export function isValidScheduleExpression(spec: ScheduleSpec): boolean {
  try {
    if (spec.syntax === 'cron') {
      new Cron(spec.expression, { maxRuns: 0 });
      return true;
    }

    if (spec.syntax === 'rrule') {
      // Require DTSTART for deterministic anchoring
      if (!spec.expression.includes('DTSTART')) {
        return false;
      }
      // Reject set constructs for now (lifted in PR 13)
      if (hasSetConstructs(spec.expression)) {
        return false;
      }
      rrulestr(spec.expression);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Compute the next run timestamp (epoch ms) for a schedule expression.
 * Throws if no future runs exist.
 */
export function computeNextRunAt(spec: ScheduleSpec, nowMs?: number): number {
  const now = nowMs ?? Date.now();

  if (spec.syntax === 'cron') {
    const cron = new Cron(spec.expression, {
      timezone: spec.timezone ?? undefined,
    });
    const next = cron.nextRun(new Date(now));
    if (!next) {
      throw new Error(`Cron expression "${spec.expression}" has no upcoming runs`);
    }
    return next.getTime();
  }

  if (spec.syntax === 'rrule') {
    if (!spec.expression.includes('DTSTART')) {
      throw new Error('RRULE expression must include DTSTART for deterministic scheduling');
    }
    if (hasSetConstructs(spec.expression)) {
      throw new Error('RRULE set constructs (RDATE, EXDATE, EXRULE, multiple RRULE) are not yet supported. Support will be added in a future update.');
    }

    const rule = rrulestr(spec.expression);
    const next = rule.after(new Date(now), true);
    if (!next) {
      throw new Error(`RRULE expression has no upcoming runs after ${new Date(now).toISOString()}`);
    }
    return next.getTime();
  }

  throw new Error(`Unsupported schedule syntax: ${spec.syntax}`);
}

/**
 * Check if an RRULE expression contains set constructs (RDATE, EXDATE, EXRULE,
 * or multiple RRULE lines). These are deferred to PR 13.
 */
function hasSetConstructs(expression: string): boolean {
  const lines = expression.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let rruleCount = 0;
  for (const line of lines) {
    if (line.startsWith('RDATE') || line.startsWith('EXDATE') || line.startsWith('EXRULE')) {
      return true;
    }
    if (line.startsWith('RRULE:')) {
      rruleCount++;
    }
  }
  return rruleCount > 1;
}
