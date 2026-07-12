/** Declarative help for the `assistant memory` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

/**
 * Memory kinds accepted by the daemon's memory-item routes. Mirrored here
 * for help text only — the route validates and rejects unknown kinds.
 */
export const MEMORY_KINDS =
  "episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared";

export const memoryHelp: CliCommandHelp = {
  name: "memory",
  description:
    "Manage memory items and maintain the assistant memory subsystem",
  helpText: `
The 'nodes' subgroup provides content-based list, delete, and update over
memory v2 graph nodes — address facts by text, not UUID (requires memory v2).

The 'items' subgroup exposes full CRUD over individual memory items
(remembered facts) — list, get, create, update, delete.

The memory subsystem retrieves concept pages two ways: the v2 concept-page
activation model (prose pages with directed edges) and the v3 section-lane
model (section-grain lanes cached as live shadow state). Each subgroup exposes
operator-facing maintenance verbs — reindexing, backfills, validation, and evals.

Examples:
  $ assistant memory nodes list --search "coffee"
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory v2 validate
  $ assistant memory v3 rebuild-index`,
  subcommands: [
    {
      name: "nodes",
      description:
        "Content-based list, delete, and update of memory graph nodes",
      helpText: `
Memory nodes are raw graph records (content, type, fidelity) produced by the
memory v2 subsystem. Unlike 'memory items', which addresses nodes by UUID, these
commands address nodes by content text — matching the way an operator refers to
a remembered fact without first looking up its ID.

All subcommands require memory v2 to be enabled and the assistant to be running.

Examples:
  $ assistant memory nodes list
  $ assistant memory nodes list --search "TypeScript" --limit 20
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"`,
      subcommands: [
        {
          name: "list",
          description: "List active memory graph nodes",
          options: [
            {
              flags: "--search <query>",
              description: "Filter nodes whose content contains <query>",
            },
            {
              flags: "--limit <n>",
              description: "Max results (default 50, max 200)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Returns active (non-deleted) memory graph nodes ordered by significance.
  With --search, all nodes are scanned so the filter is exhaustive regardless
  of graph size. Without --search the query is capped at --limit rows at the
  DB level for efficiency.

Examples:
  $ assistant memory nodes list
  $ assistant memory nodes list --search "coffee" --limit 10
  $ assistant memory nodes list --json`,
        },
        {
          name: "delete",
          args: "<content>",
          description: "Delete a memory node by content match",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <content>  The text of the memory to delete. Exact match (case-insensitive)
             takes priority; if no exact match exists, a substring match is
             tried. Fails when 0 or more than 1 nodes match — use
             'assistant memory nodes list --search <query>' to find exact text.

Behavior:
  Hard-deletes the graph node and removes it from the recall index. This
  operation is permanent; use 'assistant memory nodes update' to correct
  content instead of deleting it.

Examples:
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes delete "User prefers TypeScript" --json`,
        },
        {
          name: "update",
          args: "<old-content> <new-content>",
          description: "Update a memory node's content in place",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <old-content>  Text of the memory to update. Exact match (case-insensitive)
                 takes priority over substring match. Fails when 0 or more than
                 1 nodes match.
  <new-content>  Replacement text. Fails if another active node already has
                 this content (prevents duplicates).

Behavior:
  Replaces the node's content and re-embeds it so recall stays consistent.
  Use this to correct a fact rather than deleting and re-adding it — the edit
  history is preserved on the node.

Examples:
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory nodes update "old fact" "corrected fact" --json`,
        },
      ],
    },
    {
      name: "items",
      description: "Manage individual memory items (full CRUD)",
      helpText: `
Memory items are individual remembered facts (graph nodes) with a kind
(${MEMORY_KINDS}),
a subject line, and a statement. Items are normally created by the
assistant via the remember tool; 'items create' exists for manual seeding
and repair.

Examples:
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123`,
      subcommands: [
        {
          name: "list",
          description:
            "List memory items with filtering, search, and pagination",
          options: [
            {
              flags: "--kind <kind>",
              description: `Filter by kind (${MEMORY_KINDS})`,
            },
            {
              flags: "--status <status>",
              description:
                "Filter by status: active (default), inactive, or all",
            },
            {
              flags: "--search <query>",
              description: "Semantic/full-text search query",
            },
            {
              flags: "--sort <field>",
              description:
                "Sort field: lastSeenAt (default), importance, kind, or firstSeenAt",
            },
            {
              flags: "--order <order>",
              description: "asc or desc (default desc)",
            },
            { flags: "--limit <n>", description: "Max results (default 100)" },
            {
              flags: "--offset <n>",
              description: "Pagination offset (default 0)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Lists memory items (remembered facts) from the assistant's memory store.
  With --search, results are ranked by semantic relevance when the embedding
  backend is available, falling back to substring match otherwise. Deleted
  items are hidden unless --status inactive or --status all is passed.

Examples:
  $ assistant memory items list
  $ assistant memory items list --kind semantic --limit 20
  $ assistant memory items list --search "favorite restaurants" --json`,
        },
        {
          name: "get",
          args: "<id>",
          description: "Get a single memory item by ID",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Examples:
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        },
        {
          name: "create",
          description: "Create a new memory item",
          options: [
            {
              flags: "--kind <kind>",
              description: `Memory kind (${MEMORY_KINDS})`,
              required: true,
            },
            {
              flags: "--statement <text>",
              description: "Statement content of the memory",
              required: true,
            },
            {
              flags: "--subject <text>",
              description: "Subject line (defaults to the statement)",
            },
            {
              flags: "--importance <n>",
              description: "Importance score 0-1 (default 0.8)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Creates a memory graph node and enqueues its embedding so it becomes
  recallable. Fails with a conflict error if an active item with identical
  content already exists. Memories are normally formed by the assistant via
  the remember tool — use this for manual seeding and repair.

Examples:
  $ assistant memory items create --kind semantic --statement "User prefers dark mode"
  $ assistant memory items create --kind procedural --subject "Deploys" \\
      --statement "Deploys go out Tuesdays after standup" --importance 0.9`,
        },
        {
          name: "update",
          args: "<id>",
          description: "Update fields on an existing memory item",
          options: [
            {
              flags: "--subject <text>",
              description: "Replace the subject line",
            },
            {
              flags: "--statement <text>",
              description: "Replace the statement content",
            },
            {
              flags: "--kind <kind>",
              description: `Change the kind (${MEMORY_KINDS})`,
            },
            {
              flags: "--status <status>",
              description:
                "Set status: active (restores a deleted item) or superseded",
            },
            {
              flags: "--importance <n>",
              description: "Set importance score 0-1",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Partially updates the given fields; anything not passed is left unchanged.
  Content changes trigger re-embedding so recall stays consistent. Setting
  --status active restores a previously deleted item; --status superseded
  retires it (same effect as 'assistant memory items delete'). Fails with a
  conflict error when the new content duplicates another active item.

Examples:
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea over coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --importance 0.9 --kind semantic
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --status active`,
        },
        {
          name: "delete",
          args: "<id>",
          description: "Delete a memory item",
          options: [
            { flags: "--force", description: "Skip the confirmation prompt" },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Options:
  --force  Skip the destructive y/N confirmation prompt. Required when stdin
           is not a TTY (e.g. in scripts and CI).
  --json   Output the deletion result as compact JSON.

Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Soft-deletes the memory item — it stops being recalled and its embeddings
  are removed from the index, but the underlying record is retained. A
  deleted item can be restored with
  'assistant memory items update <id> --status active'.

Examples:
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123 --force --json`,
        },
      ],
    },
    {
      name: "v2",
      description: "Memory v2 subsystem operations (concept-page model)",
      helpText: `
The v2 memory subsystem stores prose concept pages with directed edges in
each page's frontmatter and uses activation-based retrieval. Pages live
under /workspace/memory/concepts/ and are gated behind the
memory.v2.enabled config field.

Mutating subcommands return a jobId enqueued on the memory job queue,
except reembed-skills which runs synchronously inside the assistant.
Read-only subcommands print diagnostic reports without mutating state.

Examples:
  $ assistant memory v2 validate
  $ assistant memory v2 reembed
  $ assistant memory v2 reembed-skills
  $ assistant memory v2 activation`,
      subcommands: [
        {
          name: "reembed",
          description:
            "Refresh dense + sparse vectors for every concept page in Qdrant",
          helpText: `
Fans out an embed_concept_page job per concept page slug (plus the four
reserved meta-file slugs) so each page's dense and sparse vectors get
recomputed against the current embedding backend. Useful after upgrading
the embedding model or recovering a corrupted Qdrant collection.

The fan-out runs on the background memory worker — this command returns
once the parent job is enqueued.

Examples:
  $ assistant memory v2 reembed`,
        },
        {
          name: "reembed-skills",
          description:
            "Re-seed v2 skill entries from the current skill catalog (synchronous)",
          helpText: `
Re-runs the v2 skill catalog seed against the current skill set, replacing
both the in-process skill cache and the skill entries in the unified
memory_v2_concept_pages Qdrant collection (under the skills/<id> slug
prefix). Useful after editing a skill's SKILL.md, after a feature-flag flip
changes the enabled-skill set, or to recover corrupted skill embeddings.

Unlike 'reembed' (concept pages), this runs synchronously inside the
assistant — the command returns only once the seed completes. Requires
memory.v2.enabled to be true.

Examples:
  $ assistant memory v2 reembed-skills`,
        },
        {
          name: "activation",
          description:
            "Refresh persisted activation state for every active conversation",
          helpText: `
Walks every conversation row in the activation_state table and
recomputes the persisted state without rendering or injecting a memory
block. Useful after tuning the activation params (d, c_user, c_assistant,
c_now, k, hops) so subsequent retrievals reflect the new weights without
waiting for organic per-turn updates.

The job runs on the background memory worker — this command returns once
the job is enqueued.

Examples:
  $ assistant memory v2 activation`,
        },
        {
          name: "validate",
          description:
            "Print a diagnostic report of v2 workspace state (read-only)",
          helpText: `
Walks the v2 concept-page tree on disk and reports:
  - Page count
  - Edge count (total and unique outgoing targets)
  - Missing outgoing edge targets (orphan edges)
  - Oversized pages (over the per-folder size cap)
  - Parse failures (missing or malformed frontmatter)

Read-only — does not mutate the workspace. Exits non-zero if any
violations are reported.

Examples:
  $ assistant memory v2 validate`,
        },
        {
          name: "ema",
          description:
            "List concept pages by injection-frequency EMA score (read-only)",
          options: [
            {
              flags: "-n, --limit <count>",
              description:
                "Maximum rows to print (default 25; ignored with --all)",
              defaultValue: "25",
            },
            {
              flags: "--all",
              description: "Print every page, including zero-score pages",
            },
            {
              flags: "--include-zeros",
              description:
                "Include pages with score 0 in the default-limited view",
            },
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted table",
            },
          ],
          helpText: `
EMA score is the time-decayed sum Σ exp(-λ × (now - tᵢ)) with a 3-day
half-life, computed from memory_v2_injection_events. A score of 1.0 means
roughly one router selection in the last few minutes; 0.5 means a single
selection ~3 days ago. Pages that have never been router-selected since
EMA tracking began report 0.

Examples:
  $ assistant memory v2 ema
  $ assistant memory v2 ema -n 100
  $ assistant memory v2 ema --all --json | jq '.entries | length'`,
        },
        {
          name: "simulate",
          description:
            "Dry-run the v4 router against a synthetic query (read-only)",
          options: [
            {
              flags: "-q, --query <text>",
              description: "User query to route the simulated turn against",
              required: true,
            },
            {
              flags: "--tier1-size <n>",
              description:
                "Override memory.v2.router.tier1_size for this run (number or 'null')",
            },
            {
              flags: "--tier2-size <n>",
              description:
                "Override memory.v2.router.tier2_size for this run (number or 'null')",
            },
            {
              flags: "--batch-size <n>",
              description:
                "Override memory.v2.router.batch_size for this run (number or 'null')",
            },
            {
              flags: "--json",
              description: "Emit raw JSON instead of a grouped report",
            },
          ],
          helpText: `
Runs the v4 router read-only against the live page index + EMA scores, with
optional tier/batch overrides applied on top of the live config. NO writes:
no row is appended to memory_v2_injection_events or memory_v2_activation_logs,
and no activation state is mutated. Use this to preview the effect of a
config knob change before flipping it in workspace config.json.

Limitations:
  - priorEverInjected is empty (single-turn simulation; live router dedups
    against pages already in context).
  - NOW.md is read at simulate-time, not historical-turn time.
  - assistantMessage is empty.

Pass 'null' to an override flag to explicitly disable that tier for this run
(e.g. --tier2-size null reverts to tier1 → tier3). Omitting an override
inherits the live config value.

Examples:
  $ assistant memory v2 simulate -q "what should we ship next"
  $ assistant memory v2 simulate -q "..." --tier1-size 100 --tier2-size 200 --batch-size 50
  $ assistant memory v2 simulate -q "..." --json | jq '.selectedSlugs'`,
        },
        {
          name: "compare",
          description:
            "Compare retrievers against the router's logged picks over a sample of real turns (read-only)",
          // The repeatable `--conversation <id>` option (accumulator parser +
          // array default) and the options registered after it live in
          // memory-v2.ts — the contract cannot express parser functions or
          // array defaults, and option order must match registration order.
          options: [
            {
              flags: "--limit <n>",
              description:
                "How many historical turns to sample (default 20). Each re-runs the router = one LLM call.",
            },
            {
              flags: "--strategy <recent|random>",
              description:
                "Sampling strategy over historical turns (default recent)",
            },
            {
              flags: "--k <list>",
              description:
                "Comma-separated recall@k cutoffs (default 5,10,25,50)",
            },
          ],
          helpText: `
Runs the comparison harness read-only: samples historical 'router'-mode turns
from memory_v2_activation_logs, reconstructs each turn's inputs, re-runs each
retriever, and scores selections against the logged picks (recall@k). NO writes.

Cost: each scored turn re-runs the router (one LLM call), so --limit is the
cost knob — start small. Today the only retriever is the router itself, so this
is the harness self-test (router graded against its own logged picks); the gap
from 1.0 is input-reconstruction drift (NOW.md / config moved since the turn).

Examples:
  $ assistant memory v2 compare --limit 20
  $ assistant memory v2 compare --limit 50 --strategy random --k 5,10,25
  $ assistant memory v2 compare --limit 20 --trace conv-abc:7
  $ assistant memory v2 compare --limit 20 --json | jq '.retrievers[0].aggregate'`,
        },
      ],
    },
    {
      name: "v3",
      description: "Memory v3 live-lane maintenance (section-lane model)",
      helpText: `
The v3 memory subsystem retrieves concept pages over section-grain lanes and
caches them as live shadow lanes inside the assistant. These commands maintain
that live state safely.

Examples:
  $ assistant memory v3 rebuild-index
  $ assistant memory v3 backfill-sections`,
      subcommands: [
        {
          name: "rebuild-index",
          description: "Invalidate the v3 lanes so the next turn rebuilds",
          helpText: `
Drops the assistant's cached v3 shadow lanes so the section index is rebuilt
from the current on-disk state on the next turn. Useful after editing concept
pages out-of-band.

Examples:
  $ assistant memory v3 rebuild-index`,
        },
        {
          name: "backfill-sections",
          description:
            "One-time: embed every page's sections into the dense store (incl skills/CLI)",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Embeds EVERY concept page's sections — including synthetic skill and CLI
capability rows — into the section dense store in one pass, then advances
the maintain checkpoint so the next incremental pass only re-embeds future
edits. Use this once on an existing install before the section-lane A/B and
cutover: the dense collection starts empty, and the periodic maintenance
pass only re-embeds pages edited since its last run (and never the synthetic
rows), so most of the corpus would otherwise never be embedded.

Idempotent and safe to re-run. Runs inside the assistant so it uses the live
configuration and advances the checkpoint the assistant reads.

Examples:
  $ assistant memory v3 backfill-sections
  $ assistant memory v3 backfill-sections --json | jq '.sections'`,
        },
        {
          name: "eval",
          description:
            "Build blinded A/B retrieval-eval packets (snapshot corpus vs staged wiki)",
          // The repeatable `--exclude-conversation <id>` option (accumulator
          // parser + array default) and the `--json` option after it live in
          // memory-v3.ts — the contract cannot express parser functions or
          // array defaults, and option order must match registration order.
          options: [
            {
              flags: "--staging <dir>",
              description:
                "Staged v3 wiki dir (relative to the workspace, or absolute)",
              required: true,
            },
            {
              flags: "--snapshot <dir>",
              description:
                "Read-only v2 snapshot dir (relative to the workspace, or absolute)",
              required: true,
            },
            {
              flags: "--out <dir>",
              description: "Output dir for packets.json + key.json",
              required: true,
            },
            {
              flags: "--turns <n>",
              description: "Number of recent turns to mine",
              defaultValue: "30",
            },
            {
              flags: "--k <n>",
              description: "Pages per memory set",
              defaultValue: "8",
            },
            {
              flags: "--seed <n>",
              description: "Blinding seed (reproducible A/B assignment)",
              defaultValue: "1",
            },
            {
              flags: "--no-dense",
              description:
                "Needle-only: skip section embedding (fast, cheaper, lower fidelity)",
            },
            {
              flags: "--turns-file <path>",
              description:
                "Pin the exact turns from a prior key.json/packets.json (reproducible re-judge); overrides --turns",
            },
          ],
          helpText: `
Mines recent user turns, retrieves the top pages from each corpus per turn, and
writes blinded A/B packets (plus a separate unblinding key) for a blind-judge
workflow. Both corpora are read in memory — nothing in the live lanes or Qdrant
is touched. With the dense lane on (default) it embeds every section of both
corpora, which can take a while on a large corpus; use --no-dense for a fast
lexical-only pass.

To iterate on the staged wiki reproducibly, mine the turns ONCE and pin them on
every re-run with --turns-file (pointing at the first run's key.json), so the
comparison stays fixed while only the staged corpus changes. Re-runs that
re-mine drift onto a different turn set and are not comparable. Likewise, do not
compare a --no-dense run against a dense one, and check eval-meta.json's
embedding identity is the same across runs.

Examples:
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --turns-file .mv3/eval/key.json
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --exclude-conversation <migration-conv-id>`,
        },
        {
          name: "eval-tally",
          description:
            "Unblind + tally blind-judge verdicts against key.json with a noise-aware win/tie/loss verdict",
          options: [
            {
              flags: "--verdicts <path>",
              description:
                "JSON file: array of { turn, winner, scoreA, scoreB } (one or more per turn for a panel)",
              required: true,
            },
            {
              flags: "--key <path>",
              description:
                "key.json from `eval` — the per-turn A/B → snapshot/staging unblinding map",
              required: true,
            },
            {
              flags: "--alpha <p>",
              description:
                "Significance threshold for the sign test (the wiki only FAILS on a significant snapshot lead)",
              defaultValue: "0.05",
            },
            {
              flags: "--out <path>",
              description: "Also write the full tally JSON to this path",
            },
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Joins the blind-judge verdicts to the unblinding key (A/B is shuffled PER TURN,
so the winner must be mapped turn-by-turn — a global A-vs-B count is wrong) and
applies a two-sided sign test: the wiki only FAILS when the snapshot's win lead
is statistically significant. A within-noise difference is a tie, which passes
the win-or-tie gate. Pass a judge PANEL (multiple verdicts per turn, e.g. from
re-judging under several seeds) to control single-vote noise.

Example:
  $ assistant memory v3 eval-tally --verdicts .mv3/eval/verdicts.json --key .mv3/eval/key.json`,
        },
      ],
    },
    {
      name: "retrospective",
      description: "Run and inspect memory retrospectives (direct, no IPC)",
      helpText: `
Runs memory retrospectives directly against the workspace database — the CLI
process imports the retrospective machinery and calls it in-process, so no
running daemon is required.

Examples:
  $ assistant memory retrospective run <conversationId>`,
      subcommands: [
        {
          name: "run",
          description: "Run a fork-based retrospective on a conversation",
          arguments: [
            {
              name: "<conversationId>",
              description: "Source conversation to retrospective",
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Forks the source conversation through its latest message, persists a
retrospective instruction, and wakes the fork so the agent reviews the new
messages and calls \`remember\` on anything worth saving. Runs entirely in the
CLI process — no IPC round-trip to the daemon.

Examples:
  $ assistant memory retrospective run abc123`,
        },
      ],
    },
    {
      name: "worker",
      description: "Manage the memory jobs worker process (start/stop/status)",
      helpText: `
The memory worker processes embedding, consolidation, and cleanup jobs in a
separate OS process so they do not block the assistant's main event loop. The
daemon owns the process, so it is spawned as a child of the daemon and shows up
in \`assistant ps\`.

\`start\` enables memory.worker.enabled and \`stop\` disables it, so the
assistant's synchronous in-process runner stands down (start) or takes back over
(stop) without a restart.

Examples:
  $ assistant memory worker start
  $ assistant memory worker status
  $ assistant memory worker stop`,
      subcommands: [
        {
          name: "start",
          description:
            "Start the memory worker process and enable memory.worker.enabled",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "stop",
          description:
            "Stop the memory worker process and disable memory.worker.enabled",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "status",
          description:
            "Report worker process state, memory.worker.enabled, and the synchronous runner",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
      ],
    },
  ],
};
