# Workflow templates

The heavy stages — authoring, loss-audit, blind-judge — fan out through the native workflow engine. These are **templates the assistant adapts and passes to the `run_workflow` tool**; the skill does not (and cannot) launch a workflow itself. Read the engine's own `workflows` skill before launching, then adapt the prompt wording to your taxonomy.

## Engine contract (violating any of these fails the run silently)

- The script is **synchronous** — never `await`. Host calls (`agent`/`leaf`/`map`/`parallel`/`pipeline`) return their value directly; an `async` script deadlocks on its second host call.
- `meta` must be a **pure literal with only `name` + `description`** — no variables, calls, template strings, or nested objects/arrays. The extractor captures up to the **first `}`**, so any nested brace (e.g. a `phases:` array) truncates the literal and the run fails to launch before any leaf runs. Show progress with `phase(...)` calls in the body, not in `meta`.
- The body must **`return`** its result (it runs as a function body; a bare trailing expression is discarded).
- No `Date.now()` / `Math.random()` / argless `new Date()` — they throw in the sandbox. Pass timestamps/seeds via `args`.
- Leaves get `file_read` / `file_list` / `recall` as baseline. `file_write` is granted only if you declare it in `capabilities.tools`, and resolves relative to the workspace dir. **A `schema` leaf gets NONE of these** — it runs as a single forced-tool-choice call with no tools, so it cannot read or recall. Give a schema leaf its inputs INLINE (it returns structured output); to read first, use a non-schema tool leaf that emits a JSON block you parse (see §2). Mixing `schema` with a "read these files" prompt silently confabulates.
- A failed leaf inside `map`/`parallel` comes back as `null` (the batch survives); an `agent()` call throws and fails the whole run. Use `map` + `.filter(Boolean)` so one bad cluster doesn't sink the run.
- Caps: 500 leaves/run, 6 concurrent, 3 runs concurrent (config, no flag). Cluster-grain keeps you well under. Shard across runs only if clusters exceed a few hundred; resume replays completed leaves after an interruption.

---

## 1. Author clusters (write staged articles)

Launch with `capabilities: { tools: ["file_write"] }`. One leaf per cluster — each reads its cluster's source pages and writes that cluster's whole article set into `.mv3/staging/`. (If the assistant has an established writing style worth preserving, add `persona: true` to the leaf opts and the run capabilities — but most migrations don't need it, and it is the more expensive path.)

> ⚠️ If you pin a leaf `profile`, verify it actually produces output: some profiles pass config validation yet no-op as a workflow leaf. The engine now **fails** such a leaf loudly (it lands in the run's failures), but always sanity-check `clustersAuthored` against the cluster count and spot-check `.mv3/staging/` on disk — a run that authored nothing is the first thing to rule out.

```ts
export const meta = {
  name: "memory-v3-author-clusters",
  description:
    "Author one v3 wiki article-set per topic cluster into the staging tree, with provenance.",
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

## 2. Loss audit (read a bundle, NO schema)

Read-only — no `file_write`. One leaf per cluster lists substance present in the v2 sources but missing/weakened in the staged wiki; you patch `[load-bearing]` drops verbatim afterward.

> ⚠️ **Do not give an audit leaf a `schema`.** A schema leaf runs with **no tools** — no `file_read` — so a leaf told to "read the sources and compare" reads _nothing_ and **confabulates** drops that merely fit the schema. In the field this produced hundreds of phantom findings citing files that don't exist. Use a plain (non-schema) tool leaf that reads a pre-assembled **bundle** and returns a JSON block you parse yourself, so it can only report what is literally in front of it.

Pre-assemble the bundles **host-side before launching**: for each cluster write `.mv3/audit/bundle-<cluster>.txt` containing every source page (under an `OLD SOURCE` heading, clearly delimited) followed by every staged article (under a `NEW STAGED` heading). Then launch with no side-effecting capabilities:

```ts
export const meta = {
  name: "memory-v3-loss-audit",
  description:
    "Per-cluster reader: list substance in the v2 sources missing/weakened in the staged wiki.",
};

phase("audit");

const audited = map(args.clusters, (cluster) =>
  leaf(
    [
      `Audit cluster "${cluster.id}" for information loss. Read the bundle file`,
      `${args.auditDir}/bundle-${cluster.id}.txt with file_read. It has an OLD`,
      "SOURCE half and a NEW STAGED half. List every substantive fact, quote,",
      "date, number, or detail present in the OLD half but absent or materially",
      "weakened in the NEW half. Report ONLY facts literally present in the OLD",
      "half — never infer or invent. Be strict; err toward listing.",
      "",
      "Return ONLY a fenced json block (no prose) shaped:",
      '  { "cluster": "<id>", "drops": [',
      '    { "fact": "<quote/date/number/detail>",',
      '      "severity": "load-bearing" | "secondary" | "incidental",',
      '      "sourcePath": "<snapshot path>",',
      '      "shouldLiveOn": "<staged slug + section>" } ] }',
    ].join("\n"),
    { label: `audit:${cluster.id}` }, // NO schema — keeps file_read
  ),
);

// Each leaf returns text containing a fenced json block; parse it host-side
// (strip the fences, JSON.parse). A leaf that returned no parseable block is a
// failure to re-run, not an empty audit.
return { reports: audited.filter(Boolean) };
```

---

## 3. Blind judge (inline packets, the ship gate)

Decides whether the wiki retrieves ≥ the v2 corpus. The two memory sets per turn are built **outside** the workflow (`assistant memory v3 eval` — see `eval-gate.md`) and passed in as blinded packets. Each leaf judges one turn without knowing which side is which.

Two rules make this gate trustworthy:

- **Each leaf gets its one packet INLINE** (`p.context`, `p.reply`, `p.setA`, `p.setB`). Because nothing is read from disk, a `schema` is safe here. **Never** "improve" this by having a leaf `file_read` a packet file _with a schema set_ — a schema leaf has no `file_read` and will confabulate verdicts (the §2 trap).
- **Run a panel** of `args.panel` judges per packet (default 3). A single vote per turn is noisy; the gate's confidence comes from the panel. Do **not** tally in the workflow — write the verdicts to `verdicts.json` and run `assistant memory v3 eval-tally`, which maps A/B → snapshot/staging via `key.json` (A/B is shuffled **per turn**, so a global A-vs-B count is wrong) and applies a noise-aware sign test.

```ts
export const meta = {
  name: "memory-v3-blind-judge",
  description:
    "Blind A/B content judge: per mined turn, score which memory set better covers what the reply needed.",
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    turn: { type: "string" },
    winner: { type: "string", enum: ["A", "B", "tie"] },
    scoreA: { type: "number" },
    scoreB: { type: "number" },
  },
  required: ["turn", "winner", "scoreA", "scoreB"],
};

phase("judge");

const PANEL = args.panel ?? 3;
const prompt = (p) =>
  [
    "You are a blind judge. Score each memory set 0-10 on ONE question: does this",
    "content cover what the reply actually needed? Credit the specific facts, named",
    "concepts, verbatim quotes, dates, and details the reply used or echoed. Coverage",
    "dominates; never prefer a smaller set missing needed content over a larger one",
    "that has it. Tie-break on noise. Ignore formatting and page-vs-section shape.",
    "You do not know which system produced which set.",
    "",
    `### turn ${p.turn}`,
    `Recent context:\n${p.context}`,
    `User:\n${p.userMessage}`,
    `Reply (ground truth for what memory was needed):\n${p.reply}`,
    `\n--- Memory set A ---\n${p.setA}`,
    `\n--- Memory set B ---\n${p.setB}`,
  ].join("\n");

// Flatten packets × panel into one flat fan-out (PANEL verdicts per turn).
// args.packets: [{ turn, context, userMessage, reply, setA, setB }] — A/B
// pre-shuffled per turn; the unblinding key (key.json) is kept separately.
const jobs = args.packets.flatMap((p) =>
  Array.from({ length: PANEL }, (_unused, i) => ({ p, i })),
);
const verdicts = map(jobs, (job) =>
  leaf(prompt(job.p), {
    label: `judge:${job.p.turn}:${job.i}`,
    schema: VERDICT_SCHEMA,
  }),
);

// Write `verdicts` to .mv3/eval/verdicts.json, then decide with:
//   assistant memory v3 eval-tally --verdicts .mv3/eval/verdicts.json --key .mv3/eval/key.json
return { verdicts: verdicts.filter(Boolean) };
```
