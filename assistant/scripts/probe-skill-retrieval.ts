// ---------------------------------------------------------------------------
// Skill retrieval probe: rank skill capability cards against a query offline.
//
// Skills are surfaced to a turn by embedding one capability card per skill into
// the concept-page collection and retrieving against it. The card is built from
// SKILL.md frontmatter only (`description` + `activation-hints` + `avoid-when`),
// never the body, and is hard-truncated to a character budget. This script
// builds the same cards from SKILL.md on disk, embeds them with the same local
// backend, and prints the ranking, so frontmatter wording can be validated
// without a running assistant.
//
// The dense lane is one of several retrieval lanes and its pool is handed to an
// LLM selector. A skill ranking well here is necessary for it to be surfaced,
// not sufficient.
//
// Usage (from assistant/):
//   bun run scripts/probe-skill-retrieval.ts -q "help me connect stripe link"
//   bun run scripts/probe-skill-retrieval.ts --queries queries.json --top 10
//   bun run scripts/probe-skill-retrieval.ts -q "..." --only stripe
//   bun run scripts/probe-skill-retrieval.ts --queries q.json --save before.json
//   ...edit SKILL.md...
//   bun run scripts/probe-skill-retrieval.ts --queries q.json --baseline before.json
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getConfig } from "../src/config/loader.js";
import {
  type ParsedFrontmatter,
  parseFrontmatter,
} from "../src/config/skills.js";
import { LocalEmbeddingBackend } from "../src/persistence/embeddings/embedding-local.js";
import {
  ALWAYS_CANDIDATE_CARD_CHARS,
  buildSkillContent,
  DEFAULT_CARD_CHARS,
  renderSkillCard,
} from "../src/plugins/defaults/memory/substrate/skill-content.js";

interface ProbeOptions {
  queries: string[];
  skillDirs: string[];
  top: number;
  only?: string;
  json: boolean;
  truncationReport: boolean;
  save?: string;
  baseline?: string;
}

interface Card {
  name: string;
  text: string;
  budget: number;
  /** Characters the budget cut from the end of the card, 0 when it fits. */
  lostChars: number;
}

interface Ranked {
  name: string;
  score: number;
  rank: number;
}

/** Score deltas below this are rounding, not signal, and are not reported. */
const DELTA_EPSILON = 0.0005;

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const DEFAULT_SKILL_DIRS = [
  join(REPO_ROOT, "skills"),
  join(REPO_ROOT, "assistant", "src", "config", "bundled-skills"),
];

function usage(): never {
  console.error(
    [
      "Usage: bun run scripts/probe-skill-retrieval.ts [options]",
      "",
      "  -q, --query <text>      Query to rank (repeatable)",
      "      --queries <file>    JSON array of queries, or one query per line",
      "      --skills-dir <dir>  Directory of <skill>/SKILL.md (repeatable)",
      "      --top <n>           Rows to print per query (default 8)",
      "      --only <substr>     Always print skills matching this substring",
      "      --save <file>       Write scores to a JSON baseline",
      "      --baseline <file>   Compare against a saved baseline",
      "      --json              Emit JSON instead of a table",
      "      --truncation-report List every card the budget truncates",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): ProbeOptions {
  const queries: string[] = [];
  const skillDirs: string[] = [];
  let top = 8;
  let only: string | undefined;
  let json = false;
  let truncationReport = false;
  let save: string | undefined;
  let baseline: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        usage();
      }
      return value;
    };
    switch (arg) {
      case "-q":
      case "--query":
        queries.push(next());
        break;
      case "--queries":
        queries.push(...readQueryFile(next()));
        break;
      case "--skills-dir":
        skillDirs.push(resolve(next()));
        break;
      case "--top":
        top = Number.parseInt(next(), 10);
        break;
      case "--only":
        only = next();
        break;
      case "--save":
        save = resolve(next());
        break;
      case "--baseline":
        baseline = resolve(next());
        break;
      case "--json":
        json = true;
        break;
      case "--truncation-report":
        truncationReport = true;
        break;
      default:
        usage();
    }
  }

  if (queries.length === 0 || !Number.isFinite(top) || top < 1) {
    usage();
  }

  return {
    queries,
    skillDirs: skillDirs.length > 0 ? skillDirs : DEFAULT_SKILL_DIRS,
    top,
    only,
    json,
    truncationReport,
    save,
    baseline,
  };
}

function readQueryFile(path: string): string[] {
  const raw = readFileSync(resolve(path), "utf8");
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`${path}: JSON must be an array of query strings`);
    }
    return parsed.map(String);
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function loadSkills(dirs: string[]): ParsedFrontmatter[] {
  const byName = new Map<string, ParsedFrontmatter>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      console.error(`warning: skipping unreadable skills dir ${dir}`);
      continue;
    }
    for (const entry of entries) {
      const skillPath = join(dir, entry, "SKILL.md");
      try {
        if (!statSync(skillPath).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(
        readFileSync(skillPath, "utf8"),
        skillPath,
      );
      if (parsed) {
        byName.set(parsed.name, parsed);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildCard(skill: ParsedFrontmatter): Card {
  const budget = skill.alwaysCandidate
    ? ALWAYS_CANDIDATE_CARD_CHARS
    : DEFAULT_CARD_CHARS;
  const input = {
    id: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    activationHints: skill.activationHints,
    avoidWhen: skill.avoidWhen,
  };
  const text = buildSkillContent(input, budget);
  // A card at exactly the budget was not truncated, so compare against the
  // untruncated render rather than testing `length >= budget`.
  const full = renderSkillCard(input, budget);
  return {
    name: skill.name,
    text,
    budget,
    lostChars: full.length - text.length,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function rank(
  queryVec: number[],
  cards: Card[],
  cardVecs: number[][],
): Ranked[] {
  return cards
    .map((card, i) => ({
      name: card.name,
      score: cosine(queryVec, cardVecs[i]),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

function formatDelta(
  current: Ranked,
  baseline: Record<string, number> | undefined,
): string {
  if (!baseline) {
    return "";
  }
  const before = baseline[current.name];
  if (before === undefined) {
    return "  (new)";
  }
  const delta = current.score - before;
  if (Math.abs(delta) < DELTA_EPSILON) {
    return "";
  }
  return `  (${delta > 0 ? "+" : ""}${delta.toFixed(4)})`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const skills = loadSkills(options.skillDirs);
  if (skills.length === 0) {
    throw new Error(
      `No SKILL.md files found under: ${options.skillDirs.join(", ")}`,
    );
  }
  const cards = skills.map(buildCard);

  const truncated = cards
    .filter((card) => card.lostChars > 0)
    .sort((a, b) => b.lostChars - a.lostChars);
  if (truncated.length > 0 && !options.json) {
    console.error(
      `${truncated.length} of ${cards.length} cards overrun their budget and lose trailing hints` +
        (options.truncationReport
          ? ":"
          : " (--truncation-report to list them)"),
    );
    if (options.truncationReport) {
      for (const card of truncated) {
        console.error(
          `  ${card.name}: ${card.budget + card.lostChars}/${card.budget} chars, ${card.lostChars} lost`,
        );
      }
    }
  }

  const baseline: Record<string, Record<string, number>> | undefined =
    options.baseline
      ? JSON.parse(readFileSync(options.baseline, "utf8"))
      : undefined;

  const model = getConfig().memory.embeddings.localModel;
  const backend = new LocalEmbeddingBackend(model);
  const results: Record<string, Record<string, number>> = {};

  try {
    const cardVecs = await backend.embed(cards.map((card) => card.text));
    for (const query of options.queries) {
      const [queryVec] = await backend.embed([query]);
      const ranked = rank(queryVec, cards, cardVecs);
      results[query] = Object.fromEntries(
        ranked.map((row) => [row.name, row.score]),
      );

      if (options.json) {
        continue;
      }

      console.log(`\nQ: ${query}`);
      const shown = new Set<string>();
      for (const row of ranked.slice(0, options.top)) {
        shown.add(row.name);
        console.log(
          `  ${String(row.rank).padStart(3)}. ${row.score.toFixed(4)}  ${row.name}${formatDelta(row, baseline?.[query])}`,
        );
      }
      if (options.only) {
        for (const row of ranked) {
          if (!shown.has(row.name) && row.name.includes(options.only)) {
            console.log(
              `  ${String(row.rank).padStart(3)}. ${row.score.toFixed(4)}  ${row.name}${formatDelta(row, baseline?.[query])}`,
            );
          }
        }
      }
    }
  } finally {
    backend.dispose();
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  }
  if (options.save) {
    writeFileSync(options.save, `${JSON.stringify(results, null, 2)}\n`);
    console.error(`\nSaved baseline to ${options.save}`);
  }
}

await main();
