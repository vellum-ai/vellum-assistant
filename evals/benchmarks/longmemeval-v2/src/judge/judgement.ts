/**
 * Parses the LLM judge's binary judgement output.
 *
 * V2 instructs both judges to emit `{"label": 0 or 1, "reason": "..."}`.
 * Real models still go off-script — Markdown code fences, prose around the
 * JSON, single-quoted "JSON", `label=1` shorthand. `parseLlmBinaryJudgement`
 * mirrors V2's `_parse_llm_binary_judgement`:
 *
 *  1. Strip a wrapping triple-backtick fence (with or without a language tag).
 *  2. Try to JSON-parse the first balanced `{...}` block.
 *  3. Fall back to a regex on `label: 0|1` in any common quote style.
 *  4. Throw if none of the above matches.
 */

export interface ParsedJudgement {
  label: 0 | 1;
  reason: string;
}

export function stripMarkdownCodeFence(text: string): string {
  const stripped = text.trim();
  if (stripped.startsWith("```") && stripped.endsWith("```")) {
    const lines = stripped.split("\n");
    if (lines.length >= 3) {
      return lines.slice(1, -1).join("\n").trim();
    }
  }
  return stripped;
}

export function parseLlmBinaryJudgement(text: unknown): ParsedJudgement {
  const cleaned = stripMarkdownCodeFence(stringify(text));
  if (!cleaned) {
    throw new Error("Empty judgement response from evaluator model.");
  }

  // 1) Strict JSON in the first {…} block.
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const payload = JSON.parse(jsonMatch[0]);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const label = (payload as Record<string, unknown>).label;
        if (label === 0 || label === 1 || label === "0" || label === "1") {
          const reason = stringify((payload as Record<string, unknown>).reason);
          return { label: Number(label) as 0 | 1, reason };
        }
      }
    } catch {
      // Fall through to regex extraction — matches Python.
    }
  }

  // 2) Regex fallback for non-strict JSON-shaped outputs.
  const patterns: ReadonlyArray<RegExp> = [
    /"label"\s*:\s*([01])/i,
    /'label'\s*:\s*([01])/i,
    /\blabel\b\s*[:=]\s*([01])/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return { label: Number(match[1]) as 0 | 1, reason: cleaned };
    }
  }

  throw new Error(
    `Could not parse evaluator binary judgement: ${JSON.stringify(cleaned)}`,
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}
