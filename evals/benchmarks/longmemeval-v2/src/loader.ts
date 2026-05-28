/**
 * Loader for the LongMemEval-V2 benchmark.
 *
 * Joins the normalized questions stream against a tier-specific haystack
 * mapping and produces an array of `BenchmarkItem`s ready for the harness
 * to consume.
 *
 * Inputs (under `dataRoot/`):
 *   - `questions.jsonl`             — one JSON object per line (V2 schema)
 *   - `haystacks/lme_v2_<tier>.json` — `{ question_id: trajectory_id[] }`
 *
 * Not loaded here:
 *   - `trajectories.jsonl` — the runner streams this when building the
 *     per-item haystack payload (see the upcoming `run-ingest-ask`).
 *   - `*_screenshots/`     — multimodal assets, consumed by the runner.
 *
 * Schema notes:
 *   - We validate the few fields the harness depends on (`question_id`,
 *     `question_type`, `question`, `answer`) and let the rest pass through.
 *     V2 may add fields over time; the loader stays compatible without a
 *     rev-bump as long as those four are present.
 *   - `ability` is the verbatim `question_type` string from V2. V2 ships
 *     five canonical abilities — see README — but we don't pin them in an
 *     enum here so a future hotfix-release that renames or adds an ability
 *     doesn't take the harness down.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

export const TIERS = ["small", "medium"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Subset of the V2 questions.jsonl schema we depend on.
 *
 * Per `SCHEMA.md` in the published dataset, V2 questions use `id` (not
 * `question_id` — that was the V1 field name). The schema also ships
 * `domain`, `environment`, `image`, and `eval_function` fields which the
 * runner / judge consume directly; `.passthrough()` preserves them so the
 * loader stays a single source of truth without growing here.
 */
const RawQuestionSchema = z
  .object({
    id: z.string().min(1),
    question_type: z.string().min(1),
    question: z.string().min(1),
    answer: z.string(),
    eval_function: z.string().min(1),
  })
  .passthrough();

/**
 * Haystack mapping shape. V2 ships `haystacks/lme_v2_<tier>.json` as a
 * top-level object keyed by `question_id` with a non-empty trajectory-id
 * list per value. We validate that shape strictly so a malformed haystack
 * fails loudly instead of producing items with empty haystacks downstream.
 */
const HaystackMappingSchema = z.record(z.string(), z.array(z.string()).min(1));

export interface BenchmarkItem {
  /** Stable question id from V2 `questions.jsonl` (`id` field). */
  questionId: string;
  /**
   * Verbatim `question_type` from V2 — one of the five abilities (static
   * state recall, dynamic state tracking, workflow knowledge, environment
   * gotchas, premise awareness). Kept as a string so unknown values don't
   * break the loader.
   */
  ability: string;
  /** Verbatim question text. */
  question: string;
  /** Gold answer — reference signal for the dispatched evaluator. */
  answer: string;
  /**
   * V2 `eval_function` spec string (e.g. `"norm_phrase_set_match"` or
   * `"norm_phrase_set_match_ordered|separators=>"`). Parsed and dispatched
   * by `src/judge/evalFromSpec`.
   */
  evalFunction: string;
  /**
   * Ordered trajectory ids that form this question's haystack at the
   * chosen tier. The runner resolves these against `trajectories.jsonl`.
   */
  trajectoryIds: string[];
}

export interface LoadOptions {
  /**
   * Absolute path to the LME-V2 data root (the directory that contains
   * `questions.jsonl` and `haystacks/`). Typically the directory that
   * `data/download.sh` writes into.
   */
  dataRoot: string;
  /**
   * Which haystack tier to resolve. "small" (~115k tokens of haystack
   * per question) is the publishable target; "medium" is the long-horizon
   * variant (500 trajectories per question, ~115M tokens — memory-only).
   */
  tier: Tier;
}

function parseJsonl<T>(
  raw: string,
  parseLine: (value: unknown, line: number) => T,
): T[] {
  const out: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Failed to parse JSONL at line ${i + 1}: ${(err as Error).message}`,
      );
    }
    out.push(parseLine(parsed, i + 1));
  }
  return out;
}

export async function loadLongMemEvalV2(
  opts: LoadOptions,
): Promise<BenchmarkItem[]> {
  const dataRoot = resolve(opts.dataRoot);
  const questionsPath = join(dataRoot, "questions.jsonl");
  const haystackPath = join(dataRoot, "haystacks", `lme_v2_${opts.tier}.json`);

  let questionsRaw: string;
  try {
    questionsRaw = await readFile(questionsPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `LongMemEval-V2 questions.jsonl not found at ${questionsPath}. ` +
          `Run \`bash data/download.sh\` from the benchmark directory.`,
      );
    }
    throw err;
  }

  let haystackRaw: string;
  try {
    haystackRaw = await readFile(haystackPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `LongMemEval-V2 haystack mapping for tier "${opts.tier}" not found at ${haystackPath}. ` +
          `Run \`bash data/download.sh\` from the benchmark directory.`,
      );
    }
    throw err;
  }

  let haystackParsed: unknown;
  try {
    haystackParsed = JSON.parse(haystackRaw);
  } catch (err) {
    throw new Error(
      `Failed to parse haystack mapping at ${haystackPath}: ${(err as Error).message}`,
    );
  }

  const haystackResult = HaystackMappingSchema.safeParse(haystackParsed);
  if (!haystackResult.success) {
    const issues = haystackResult.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Haystack mapping at ${haystackPath} failed schema validation:\n${issues}`,
    );
  }
  const haystack = haystackResult.data;

  const questions = parseJsonl(questionsRaw, (value, line) => {
    const parsed = RawQuestionSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n");
      throw new Error(
        `questions.jsonl line ${line} failed schema validation:\n${issues}`,
      );
    }
    return parsed.data;
  });

  const items: BenchmarkItem[] = [];
  const missing: string[] = [];
  for (const q of questions) {
    const trajectoryIds = haystack[q.id];
    if (trajectoryIds === undefined) {
      missing.push(q.id);
      continue;
    }
    items.push({
      questionId: q.id,
      ability: q.question_type,
      question: q.question,
      answer: q.answer,
      evalFunction: q.eval_function,
      trajectoryIds,
    });
  }

  if (missing.length > 0) {
    // Strict join: every question must have a haystack at the requested
    // tier. A silent drop here would produce inconsistent run sizes
    // across tiers and bury the underlying data drift.
    throw new Error(
      `Tier "${opts.tier}" haystack mapping is missing ${missing.length} ` +
        `question id(s) referenced by questions.jsonl ` +
        `(first few: ${missing.slice(0, 5).join(", ")}).`,
    );
  }

  return items;
}
