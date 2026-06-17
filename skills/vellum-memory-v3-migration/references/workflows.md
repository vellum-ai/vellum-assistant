# Workflow templates

The heavy stages — authoring, loss-audit, blind-judge — fan out through the native workflow engine. These are **templates the assistant adapts and passes to the `run_workflow` tool**; the skill does not (and cannot) launch a workflow itself. Read the engine's own `workflows` skill before launching, then adapt the prompt wording to your taxonomy.

## Engine contract (violating any of these fails the run silently)

- The script is **synchronous** — never `await`. Host calls (`agent`/`leaf`/`map`/`parallel`/`pipeline`) return their value directly; an `async` script deadlocks on its second host call.
- `meta` must be a **pure literal** — no variables, calls, or template strings. It's parsed statically.
- The body must **`return`** its result (it runs as a function body; a bare trailing expression is discarded).
- No `Date.now()` / `Math.random()` / argless `new Date()` — they throw in the sandbox. Pass timestamps/seeds via `args`.
- Leaves get `file_read` / `file_list` / `recall` as baseline. `file_write` is granted only if you declare it in `capabilities.tools`, and resolves relative to the workspace dir.
- A failed leaf inside `map`/`parallel` comes back as `null` (the batch survives); an `agent()` call throws and fails the whole run. Use `map` + `.filter(Boolean)` so one bad cluster doesn't sink the run.
- Caps: 500 leaves/run, 6 concurrent, 3 runs concurrent (config, no flag). Cluster-grain keeps you well under. Shard across runs only if clusters exceed a few hundred; resume replays completed leaves after an interruption.

---

## 1. Author clusters (write staged articles)

Launch with `capabilities: { tools: ["file_write"] }`. One leaf per cluster — each reads its cluster's source pages and writes that cluster's whole article set into `.mv3/staging/`. (If the assistant has an established writing style worth preserving, add `persona: true` to the leaf opts and the run capabilities — but most migrations don't need it, and it is the more expensive path.)

```ts
export const meta = {
  name: "memory-v3-author-clusters",
  description:
    "Author one v3 wiki article-set per topic cluster into the staging tree, with provenance.",
  phases: [{ title: "author" }],
};

phase("author");

const results = map(args.clusters, (cluster) =>
  leaf(
    [
      "You are reorganizing a cluster of old memory pages into the v3 wiki format. Convert one topic cluster",
      "of old v2 pages into v3 articles. This is a RELOCATION, not a fresh summary: preserve every",
      "distinct fact, quote, date, and detail; merge only co-located near-verbatim restatements.",
      "",
      `## Cluster: ${cluster.id}   (hub: ${cluster.hubSlug})`,
      "Source pages (read each in full with file_read before writing):",
      ...cluster.sourcePaths.map((p) => `  - ${p}`),
      "",
      "## The v3 article shape you must produce",
      args.principles, // paste references/v3-wiki-principles.md (or its load-bearing rules)
      "",
      "## Output",
      `Write the cluster's full article set into ${args.stagingDir}/ as flat-slug .md files (a hub`,
      "article with kind:index if needed, plus one article per topic/event). Every article: lead-as-card",
      "+ named ## sections, flat slug, main: = the hub, links: annotated, NO summary:, status: draft.",
      `Then write provenance to ${args.provenanceDir}/${cluster.id}.json as`,
      '  [{ "slug": "<staged slug>", "sources": ["<snapshot path>", ...] }]',
      'Every source path for this cluster must appear under some article (or slug "unrouted").',
      "Return one-line JSON: { cluster, articlesWritten, sourcesConsumed }.",
    ].join("\n"),
    { label: `author:${cluster.id}` },
  ),
);

const authored = results.filter(Boolean);
return {
  clustersRequested: args.clusters.length,
  clustersAuthored: authored.length,
  failed: args.clusters.map((c) => c.id).filter((_, i) => results[i] === null),
  summaries: authored,
};
```

---

## 2. Loss audit (schema leaves, read-only)

Read-only — no `file_write`. A cheap, impartial reader panel; launch with no side-effecting capabilities. One leaf per cluster reads source-vs-staged and reports drops; you patch `[load-bearing]` drops verbatim afterward.

```ts
export const meta = {
  name: "memory-v3-loss-audit",
  description:
    "Per-cluster reader panel: list substance present in the v2 sources but missing/weakened in the staged wiki.",
  phases: [{ title: "audit" }],
};

const DROP_SCHEMA = {
  type: "object",
  properties: {
    cluster: { type: "string" },
    drops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "the specific quote/date/number/detail that is missing or weakened",
          },
          severity: {
            type: "string",
            enum: ["load-bearing", "secondary", "incidental"],
          },
          sourcePath: { type: "string" },
          shouldLiveOn: {
            type: "string",
            description: "staged slug + section where it belongs",
          },
        },
        required: ["fact", "severity", "sourcePath", "shouldLiveOn"],
      },
    },
  },
  required: ["cluster", "drops"],
};

phase("audit");

const audited = map(args.clusters, (cluster) =>
  leaf(
    [
      `Audit cluster "${cluster.id}" for information loss. Read each SOURCE page and each STAGED article`,
      "in full. List every substantive fact, quote, date, number, or detail that is present in a source",
      "but absent or materially weakened in the staged articles. Be strict; err toward listing.",
      "",
      "Sources:",
      ...cluster.sourcePaths.map((p) => `  - ${p}`),
      "Staged:",
      ...cluster.stagedPaths.map((p) => `  - ${p}`),
    ].join("\n"),
    { label: `audit:${cluster.id}`, schema: DROP_SCHEMA },
  ),
);

const reports = audited.filter(Boolean);
return {
  loadBearingDrops: reports.flatMap((r) =>
    r.drops.filter((d) => d.severity === "load-bearing"),
  ),
  allReports: reports,
};
```

---

## 3. Blind judge (schema leaves, the ship gate)

Decides whether the wiki retrieves ≥ the v2 corpus. The two memory sets per turn are built **outside** the workflow (the retrieval/eval step — see `eval-gate.md`), then passed in as blinded packets. Each leaf judges one turn without knowing which side is which.

```ts
export const meta = {
  name: "memory-v3-blind-judge",
  description:
    "Blind A/B content judge: per mined turn, score which memory set better covers what the reply needed.",
  phases: [{ title: "judge" }],
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    turn: { type: "string" },
    winner: { type: "string", enum: ["A", "B", "tie"] },
    scoreA: { type: "number" },
    scoreB: { type: "number" },
    why: { type: "string" },
  },
  required: ["turn", "winner", "scoreA", "scoreB", "why"],
};

phase("judge");

// args.packets: [{ turn, context, userMessage, reply, setA, setB }]
// A/B are pre-shuffled per turn outside the workflow; the unblinding key is kept separately.
const verdicts = map(args.packets, (p) =>
  leaf(
    [
      "You are a blind judge. Score each memory set 0-10 on ONE question: does this content cover what",
      "the reply actually needed? Credit the specific facts, named concepts, verbatim quotes, dates, and",
      "details the reply used or echoed. Coverage dominates; never prefer a smaller set that",
      "is missing needed content over a larger one that has it. Tie-break on noise. Ignore formatting and",
      "page-vs-section shape. You do not know which system produced which set.",
      "",
      `### turn ${p.turn}`,
      `Recent context:\n${p.context}`,
      `User:\n${p.userMessage}`,
      `Reply (ground truth for what memory was needed):\n${p.reply}`,
      `\n--- Memory set A ---\n${p.setA}`,
      `\n--- Memory set B ---\n${p.setB}`,
    ].join("\n"),
    { label: `judge:${p.turn}`, schema: VERDICT_SCHEMA },
  ),
);

const v = verdicts.filter(Boolean);
return {
  judged: v.length,
  // Caller maps A/B back to v2/wiki via the unblinding key, then tallies wins.
  verdicts: v,
};
```
