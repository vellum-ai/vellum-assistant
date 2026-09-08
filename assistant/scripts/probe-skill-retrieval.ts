// ---------------------------------------------------------------------------
// Skill retrieval probe: rank skill capability cards against a query offline.
//
// Skills are surfaced to a turn by embedding one capability card per skill into
// the concept-page collection and retrieving against it. The card is built from
// SKILL.md frontmatter only (`description` + `activation-hints` + `avoid-when`),
// never the body, and is hard-truncated to a character budget. This script
// builds the same cards from SKILL.md on disk, embeds them with the assistant's
// local backend, and prints the ranking, so frontmatter wording can be validated
// without a running assistant. `--provider configured` ranks in the workspace's
// own embedding space instead, which needs a host that can reach its provider.
//
// Two limits on what a run proves. The dense lane is one of several retrieval
// lanes and its pool is handed to an LLM selector, so a skill ranking well here
// is necessary for it to be surfaced, not sufficient. And the pool is every
// SKILL.md on disk that this platform can run, where a real workspace also
// resolves feature flags, plugin ownership, and per-skill enabled state, so a
// host with skills disabled sees a slightly smaller field than this.
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
import {
  ALWAYS_CANDIDATE_CARD_CHARS,
  augmentMcpSetupDescription,
  buildSkillContent,
  DEFAULT_CARD_CHARS,
  renderSkillCard,
} from "../src/plugins/defaults/memory/substrate/skill-content.js";
import { filterSkillsByPlatform } from "../src/skills/platform-compatibility.js";

interface ProbeOptions {
  queries: string[];
  skillDirs: string[];
  top: number;
  only?: string;
  json: boolean;
  truncationReport: boolean;
  platform: NodeJS.Platform;
  useConfiguredProvider: boolean;
  save?: string;
  baseline?: string;
}

/** `--platform` takes the skill-facing names, not node's `process.platform`. */
const PLATFORM_ALIASES: Record<string, NodeJS.Platform> = {
  macos: "darwin",
  windows: "win32",
  linux: "linux",
};

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

/** An embedding backend plus the teardown that lets the process exit. */
interface Embedder {
  embed: (texts: string[]) => Promise<number[][]>;
  dispose: () => Promise<void> | void;
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
      "      --platform <name>   Rank as macos | windows | linux (default: this host)",
      "      --provider <name>   local (default, no daemon) | configured (workspace provider)",
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
  let platform: NodeJS.Platform = process.platform;
  let useConfiguredProvider = false;
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
      case "--provider": {
        const value = next();
        if (value !== "local" && value !== "configured") {
          console.error(
            `Unknown --provider "${value}". Expected "local" or "configured".`,
          );
          process.exit(1);
        }
        useConfiguredProvider = value === "configured";
        break;
      }
      case "--platform": {
        const value = next();
        const resolved = PLATFORM_ALIASES[value];
        if (!resolved) {
          console.error(
            `Unknown --platform "${value}". Expected one of: ${Object.keys(PLATFORM_ALIASES).join(", ")}`,
          );
          process.exit(1);
        }
        platform = resolved;
        break;
      }
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
    platform,
    useConfiguredProvider,
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

function loadSkills(
  dirs: string[],
  platform: NodeJS.Platform,
): ParsedFrontmatter[] {
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
  // Production never seeds a card for a skill the host cannot run, so leaving
  // the other platforms' skills in would put candidates in the pool that no
  // real retrieval could return, shifting every rank below them.
  const eligible = filterSkillsByPlatform([...byName.values()], platform);
  return eligible.sort((a, b) => a.name.localeCompare(b.name));
}

function buildCard(skill: ParsedFrontmatter): Card {
  const budget = skill.alwaysCandidate
    ? ALWAYS_CANDIDATE_CARD_CHARS
    : DEFAULT_CARD_CHARS;
  // Mirrors `buildInstalledSkillCards`: mcp-setup's card carries the configured
  // server names, so a query naming a server has to score against them here too.
  const input = augmentMcpSetupDescription({
    id: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    activationHints: skill.activationHints,
    avoidWhen: skill.avoidWhen,
  });
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

/**
 * Embed through the provider the workspace config selects, which is what
 * production ranks in, and fall back to the in-process local backend when that
 * provider is unreachable (no key, no network, billing breaker open). Scores
 * are not comparable across embedding models, so the provider actually used is
 * always reported rather than assumed.
 */
/**
 * Pick the embedding space the ranking is measured in.
 *
 * Local is the default because it is the only backend that runs with no
 * daemon: `embedWithBackend` resolves provider credentials through the
 * credential store, which blocks when no assistant is running. `--provider
 * configured` opts into the full production path on a host that has one.
 *
 * Scores are not comparable across embedding models, so the provider actually
 * used is reported rather than assumed, and a saved baseline should only be
 * diffed against a run that used the same one.
 */
async function resolveEmbedder(
  config: ReturnType<typeof getConfig>,
  useConfiguredProvider: boolean,
  quiet: boolean,
): Promise<Embedder> {
  const announce = (message: string): void => {
    if (!quiet) {
      console.error(message);
    }
  };
  if (useConfiguredProvider) {
    // Imported here rather than at module scope: the memory embeddings module
    // pulls in the Qdrant client, whose import-time setup stalls with no
    // assistant running, which would hang the local path too.
    const { embedWithBackend } =
      await import("../src/plugins/defaults/memory/embeddings.js");
    const probe = await embedWithBackend(config, ["probe"]);
    announce(`Embedding with ${probe.provider} / ${probe.model}`);
    const { shutdownEmbeddingBackends } =
      await import("../src/persistence/embeddings/embedding-backend.js");
    return {
      embed: async (texts) => (await embedWithBackend(config, texts)).vectors,
      dispose: () => shutdownEmbeddingBackends(),
    };
  }
  const localModel = config.memory.embeddings.localModel;
  announce(
    `Embedding with local / ${localModel}. Pass --provider configured to rank in the workspace's own embedding space.`,
  );
  const { LocalEmbeddingBackend } =
    await import("../src/persistence/embeddings/embedding-local.js");
  const backend = new LocalEmbeddingBackend(localModel);
  return {
    embed: (texts) => backend.embed(texts),
    // The backend is constructed here rather than handed out by
    // `selectEmbeddingBackend`, so the shared shutdown path does not know about
    // it. A one-shot script has nothing to drain, so the worker is killed
    // outright: `dispose()` only closes it once idle, which leaves it running
    // and the process alive.
    dispose: () => {
      backend.terminateNow();
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const skills = loadSkills(options.skillDirs, options.platform);
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

  // Embed through the same entry point production uses, so the provider the
  // workspace config selects is the provider the ranking is measured in.
  // Scores are not comparable across embedding models, which is why the
  // provider and model are reported alongside them.
  const config = getConfig();
  const embedder = await resolveEmbedder(
    config,
    options.useConfiguredProvider,
    options.json,
  );
  const embed = embedder.embed;
  const results: Record<string, Record<string, number>> = {};

  try {
    const cardVecs = await embed(cards.map((card) => card.text));
    for (const query of options.queries) {
      const [queryVec] = await embed([query]);
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
    const { shutdownEmbeddingBackends } =
      await import("../src/persistence/embeddings/embedding-backend.js");
    await shutdownEmbeddingBackends();
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

// The embedding worker leaves handles the runtime still counts as live work, so
// a one-shot run would otherwise sit at an idle event loop after printing.
process.exit(0);
