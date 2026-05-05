import { Cron } from "croner";
import { RRuleSet, rrulestr } from "rrule";

import type { ScheduleSyntax } from "./recurrence-types.js";

export interface ScheduleSpec {
  syntax: ScheduleSyntax;
  expression: string;
  timezone?: string | null;
}

const SUPPORTED_RRULE_PREFIXES = [
  "DTSTART",
  "RRULE:",
  "RDATE",
  "EXDATE",
  "EXRULE",
];

function normalizeRruleExpression(expression: string): string {
  // Handle escaped newlines from JSON transport, then uppercase property name
  // prefixes (before the first ';' or ':') on each line so rrulestr() receives
  // the canonical uppercase form regardless of what the caller provided. We
  // stop at the earliest delimiter to preserve case-sensitive parameter values
  // such as timezone names in DTSTART;TZID=America/New_York:...
  return expression
    .replace(/\\n/g, "\n")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const colonIdx = line.indexOf(":");
      const semiIdx = line.indexOf(";");
      if (colonIdx === -1 && semiIdx === -1) return line;
      // Uppercase only the property name (before the first ';' or ':')
      const nameEnd =
        semiIdx !== -1 && (colonIdx === -1 || semiIdx < colonIdx)
          ? semiIdx
          : colonIdx;
      return line.slice(0, nameEnd).toUpperCase() + line.slice(nameEnd);
    })
    .join("\n");
}

function parseRruleLines(expression: string): string[] {
  return normalizeRruleExpression(expression)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function validateRruleLines(lines: string[]): string | null {
  let hasInclusion = false;
  let hasDtstart = false;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (!SUPPORTED_RRULE_PREFIXES.some((p) => upper.startsWith(p))) {
      return `Unsupported recurrence line: ${line}`;
    }
    if (upper.startsWith("DTSTART")) hasDtstart = true;
    if (upper.startsWith("RRULE:") || upper.startsWith("RDATE"))
      hasInclusion = true;
  }

  if (!hasDtstart)
    return "RRULE expression must include DTSTART for deterministic scheduling";
  if (!hasInclusion)
    return "RRULE expression must include at least one RRULE or RDATE";
  return null;
}

/**
 * Detect whether an RRULE expression contains set constructs (RDATE, EXDATE,
 * EXRULE, or multiple RRULE lines) that require RRuleSet parsing.
 */
export function hasSetConstructs(expression: string): boolean {
  const lines = parseRruleLines(expression);
  let rruleCount = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (
      upper.startsWith("RDATE") ||
      upper.startsWith("EXDATE") ||
      upper.startsWith("EXRULE")
    )
      return true;
    if (upper.startsWith("RRULE:")) rruleCount++;
  }
  return rruleCount > 1;
}

/**
 * Validate RRULE set lines in an expression. Returns null if valid, or an
 * actionable error string describing the problem. This is intended for tool
 * layers that want to surface a specific error message before calling the
 * store.
 */
export function validateRruleSetLines(expression: string): string | null {
  const lines = parseRruleLines(expression);
  return validateRruleLines(lines);
}

/**
 * Validate a schedule expression. Returns true if the expression is valid
 * for the given syntax, false otherwise.
 */
export function isValidScheduleExpression(spec: ScheduleSpec): boolean {
  try {
    if (spec.syntax === "cron") {
      new Cron(spec.expression, {
        maxRuns: 0,
        timezone: spec.timezone ?? undefined,
      });
      return true;
    }

    if (spec.syntax === "rrule") {
      const lines = parseRruleLines(spec.expression);
      const error = validateRruleLines(lines);
      if (error) return false;

      const normalized = normalizeRruleExpression(spec.expression);
      const tzid = spec.timezone ?? undefined;
      if (hasSetConstructs(normalized)) {
        rrulestr(normalized, { forceset: true, tzid });
      } else {
        rrulestr(normalized, { tzid });
      }
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

  if (spec.syntax === "cron") {
    const cron = new Cron(spec.expression, {
      timezone: spec.timezone ?? undefined,
    });
    const next = cron.nextRun(new Date(now));
    if (!next) {
      throw new Error(
        `Cron expression "${spec.expression}" has no upcoming runs`,
      );
    }
    return next.getTime();
  }

  if (spec.syntax === "rrule") {
    const normalized = normalizeRruleExpression(spec.expression);
    const lines = parseRruleLines(normalized);
    const error = validateRruleLines(lines);
    if (error) throw new Error(error);

    const useSet = hasSetConstructs(normalized);
    const tzid = spec.timezone ?? undefined;
    const parsed = useSet
      ? (rrulestr(normalized, { forceset: true, tzid }) as RRuleSet)
      : rrulestr(normalized, { tzid });
    const next = parsed.after(new Date(now));
    if (!next) {
      // When after() (exclusive) returns null the rule may still have a
      // terminal occurrence that lands exactly on `now` — e.g. COUNT=1 or the
      // final UNTIL instance.  Treat that as "due right now" so claimDueSchedules
      // doesn't silently skip the last run.
      const exactMatch = parsed.before(new Date(now), true);
      if (exactMatch && exactMatch.getTime() === now) {
        return now;
      }
      throw new Error(
        `RRULE expression has no upcoming runs after ${new Date(
          now,
        ).toISOString()}`,
      );
    }
    return next.getTime();
  }

  throw new Error(`Unsupported schedule syntax: ${spec.syntax}`);
}
