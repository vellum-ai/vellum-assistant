export type ScheduleSyntax = 'cron' | 'rrule';

/**
 * Detect whether an expression string is cron or RRULE syntax.
 * Returns null for ambiguous or invalid expressions.
 */
export function detectScheduleSyntax(expression: string): ScheduleSyntax | null {
  if (!expression || typeof expression !== 'string') return null;
  const trimmed = expression.trim();
  if (!trimmed) return null;

  // RRULE detection: starts with RRULE:, DTSTART, or contains FREQ=
  if (/^(RRULE:|DTSTART)/m.test(trimmed) || /FREQ=/i.test(trimmed)) {
    return 'rrule';
  }

  // Cron detection: 5 space-separated fields
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5) {
    // Basic sanity check: each field should match cron-like characters
    const cronFieldPattern = /^[\d\*\/\-\,\?LW#]+$/;
    if (fields.every(f => cronFieldPattern.test(f))) {
      return 'cron';
    }
  }

  return null;
}

/**
 * Normalize schedule syntax from tool/API inputs.
 * Resolution order:
 * 1. If explicit `syntax` is provided, use it
 * 2. If `expression` is provided, auto-detect from expression
 * 3. If `legacyCronExpression` is provided, treat as cron
 * 4. Return null if nothing resolved
 */
export function normalizeScheduleSyntax(input: {
  syntax?: ScheduleSyntax;
  expression?: string;
  legacyCronExpression?: string;
}): { syntax: ScheduleSyntax; expression: string } | null {
  // Explicit syntax + expression
  if (input.syntax && input.expression) {
    return { syntax: input.syntax, expression: input.expression };
  }

  // Auto-detect from expression
  if (input.expression) {
    const detected = detectScheduleSyntax(input.expression);
    if (detected) {
      return { syntax: detected, expression: input.expression };
    }
    // If we have an explicit syntax but couldn't detect, trust the explicit syntax
    if (input.syntax) {
      return { syntax: input.syntax, expression: input.expression };
    }
    return null;
  }

  // Legacy cron_expression fallback
  if (input.legacyCronExpression) {
    return { syntax: input.syntax ?? 'cron', expression: input.legacyCronExpression };
  }

  return null;
}
