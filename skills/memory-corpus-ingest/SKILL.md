---
name: memory-corpus-ingest
description: Ingest a large dataset into memory as a skimmed map. Cold-store the raw files under a workspace imports directory, census them into a slice plan, skim each slice into compact map pages that point back at the raw files, ingest the map with the memory ingest CLI, and author a drill-in retrieval skill so the corpus stays searchable on demand. For recording archives, transcript collections, document dumps, and any corpus too large to hold in memory directly.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🗺️"
  vellum:
    category: "system"
    display-name: "Corpus Ingest"
    user-invocable: true
    activation-hints:
      - "User wants to import a large dataset, recordings archive, or document dump into memory"
      - "User asks the assistant to learn a big folder of files or a document collection"
      - "User mentions a Fathom recordings export or an archive of meeting transcripts"
      - "User wants the assistant to know what is in a corpus without pasting it all into chat"
    avoid-when:
      - "The input is a small set of distilled memories or an export from another assistant (use assistant-migration)"
      - "The input is ChatGPT conversation history (use chatgpt-import)"
---

# Corpus Ingest

Bring a large dataset into the assistant's working knowledge without stuffing it into memory. The model is a library: the workspace holds the stacks (the raw files, cold and complete), memory holds the card catalog (a small set of map pages that say what exists, when it is from, and where to look), and a purpose-built retrieval skill is the librarian that walks to the right shelf on demand.

Two invariants drive everything below:

1. **Raw data never enters the memory corpus.** Nothing from the dataset is written into `memory/concepts/` except the map pages, and nothing is ever appended to `memory/buffer.md` (bulk buffer appends trip the consolidation burst guard and per-run caps; the map bypasses the buffer entirely via `assistant memory ingest`).
2. **The map stays small.** Roughly 10 to 50 pages regardless of corpus size. If the corpus doubles, the pages get denser or the slices get coarser; the page count does not double.

## Procedure

### Step 1: Scope and confirm

Identify the source and its size before committing:

```bash
du -sh /path/to/raw-corpus
find /path/to/raw-corpus -type f | wc -l
```

Tell the user what will happen: the raw files move into the workspace, a bounded number of summarization passes read them once to build the map, the map is ingested into memory, and a lookup skill is authored for drill-in. Skimming a large corpus is real LLM work that costs time and money; confirm before starting. For Fathom recording exports, read `references/fathom.md` first for format discovery and slicing guidance.

### Step 2: Cold-store the raw corpus

Land the raw files under an imports directory in the workspace, one directory per source:

Screen for credentials BEFORE copying: an arbitrary corpus can carry secret
material, and anything landed under `imports/` becomes reachable by workspace
tools, backups, and retrieval flows.

```bash
cd "$VELLUM_WORKSPACE_DIR"
# 1a. Screen for secret-bearing FILE NAMES; review every hit with the user.
find /path/to/raw-corpus \( -name '.env*' -o -name '*.key' -o -name '*.pem' \
  -o -name '*credential*' -o -name '*secret*' -o -name 'cookies*' \
  -o -path '*tokens*' -o -path '*oauth*' \) -print

# 1b. Screen file CONTENTS for credential shapes. --hidden and --no-ignore
#     matter: rg skips dotfiles and gitignored paths by default, which is
#     exactly where credentials live. Capture the FULL list (no truncation):
#     every file named here must be excluded below or cleaned with the user
#     before it lands.
rg -l -i --hidden --no-ignore \
  "api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password\s*[=:]|passwd|bearer |AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY" \
  /path/to/raw-corpus > /tmp/corpus-secret-hits.txt
cat /tmp/corpus-secret-hits.txt

# 2. Build rsync exclusions from the content hits (paths relative to the
#    corpus root), then copy with ALL flagged paths excluded.
sed 's|^/path/to/raw-corpus/||' /tmp/corpus-secret-hits.txt > /tmp/corpus-secret-exclusions.txt
mkdir -p imports/<source>
rsync -a --exclude='.env*' --exclude='*.key' --exclude='*.pem' \
  --exclude='tokens/' --exclude='oauth/' --exclude='cookies*' \
  --exclude-from=/tmp/corpus-secret-exclusions.txt \
  /path/to/raw-corpus/ imports/<source>/
```

Rules:

- **Never place raw corpus files under `memory/`.** The cold store is `imports/<source>/`; the map is the only thing that enters memory.
- **Never land credentials in the cold store.** Exclude secret-bearing files during the copy; if the content screen finds embedded live tokens inside otherwise-wanted files, pause and resolve them with the user before landing those files.
- Treat the cold store as read-only once landed. The map pages and the drill-in skill both point at these paths; moving files later breaks every pointer.
- If the corpus is huge, check free disk space first and copy in batches. Prefer copy over move until the user confirms the original can be released.

### Step 3: Inventory and slice plan

Census the corpus and produce a machine-readable slice plan:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR/imports/<source>/.staging"
bun run {baseDir}/scripts/inventory.ts "$VELLUM_WORKSPACE_DIR/imports/<source>" \
  > "$VELLUM_WORKSPACE_DIR/imports/<source>/.staging/plan.json"
```

The script prints a human census to stderr (file count, total size, extension mix, date range) and a JSON plan to stdout: `{ files, totalBytes, byExtension, dateRange, suggestedSlices }`. Each suggested slice is a date-windowed group of files sized for one skim pass. Review the plan before skimming:

- If the slice count is outside roughly 10 to 50, adjust: merge sparse adjacent slices or split dense ones. The plan is a suggestion, not a contract.
- Files with no recognizable date cluster on file mtime; if mtimes are all import-day (a fresh copy), pick slices by directory or topic instead and say so in the map.

### Step 4: Skim each slice into a staged map page

For each slice in the plan, run one summarization pass that reads the slice's files and writes one staged map page:

- Output goes to the staging directory as `<slug>.md` (for example `imports/fathom/.staging/fathom-recordings-2025-q1.md`). The slug is the filename minus `.md`.
- Every page follows `references/map-page-template.md` exactly: lead that stands alone as the retrieval card, a `Raw data:` pointer line in the lead, `## ` sections per topic or time slice, and `source:` / `origin_date:` / `ref_files:` / `links:` frontmatter.
- Also write one corpus index page (`kind: index`) whose `links:` enumerate all slice pages.

**Bound the fan-out.** The number of skim passes equals the number of slices in the plan, full stop. Run them a few at a time (parallelism of 3 or 4 is plenty). Never spawn one pass per file, never let a pass recursively spawn more passes, and never re-skim slices that already have a staged page unless their content changed. An unbounded fan-out over a large corpus is the expensive failure mode of this skill.

A skim pass extracts what a future search needs to route: decisions, recurring topics, named people and projects, date spans, open threads. It does not transcribe. Verbatim content stays cold; the map records that it exists and where.

### Step 5: Ingest the map

Dry-run first, review, then ingest for real:

```bash
cd "$VELLUM_WORKSPACE_DIR"
assistant memory ingest --dir imports/<source>/.staging --dry-run
```

The dry run validates every page and reports per-page results without writing. Fix anything reported `invalid` (bad frontmatter, bad slug), and resolve any warning about a `links:` or `[[wikilink]]` target that is neither on disk nor in the staged set (stage the missing page, or make the reference plain prose; retrieval drops a link whose target page does not exist), then run without `--dry-run`. Notes:

- Requires concept-page memory (`memory.v3.live` or `memory.v2.enabled`).
- Existing slugs are skipped unless `--overwrite` is passed; use `--overwrite` when re-running after edits.
- Pages go up in batches of 200 (a map should never get near that).
- If the command fails because the consolidation lock is held, it names the holder; wait for that run to finish and retry.

After ingest, the maintain job picks up the new pages and embeds their sections; the map becomes retrievable shortly after, with each page's card dated by its `origin_date` rather than the import day.

### Step 6: Author the drill-in retrieval skill

The map tells the model a slice exists; the drill-in skill is how it follows the pointer. Author a workspace skill for this corpus under `$VELLUM_WORKSPACE_DIR/skills/<source>-lookup/`:

- `SKILL.md` with frontmatter per the Agent Skills spec (`name` matching the directory, keyword-rich `description`) and activation hints drawn from the intents you actually observed while scoping (for example "when the user asks what was said in a meeting", "when a question needs the <source> archive").
- `scripts/` with actually runnable search commands over the cold store, not prose descriptions of searching. A minimal helper is a ripgrep wrapper scoped to the imports directory with date filtering:

```bash
#!/usr/bin/env bash
# search.sh <pattern> [YYYY-MM]  scoped search over the <source> cold store
DIR="$VELLUM_WORKSPACE_DIR/imports/<source>"
if [ -n "$2" ]; then
  # Two globs: a slash-free pattern matches the date in any basename, and
  # the "**/" prefixed pattern matches the date in a directory segment at
  # any depth (a leading "*" cannot cross path separators).
  rg -i -C 3 "$1" "$DIR" --glob "*$2*" --glob "**/*$2*/**"
else
  rg -i -C 3 "$1" "$DIR"
fi
```

- The skill body should name the cold-store root, the slice layout, and the map pages' slugs so the model can go from a card to a file in one step.

Confirm the new skill appears in `assistant skills list` (workspace skills are picked up from the workspace `skills/` directory).

### Step 7: Verify

Run 3 to 5 representative queries a real user would ask of this corpus (mix a routing question, a specific-fact question, and a date-scoped question). For each, check:

1. A map card is selected for the turn (the slice page or the corpus index surfaces).
2. The assistant follows the card's `Raw data:` pointer or invokes the drill-in skill to reach the actual files.
3. The answer cites content that exists in the cold store.

If a query routes to nothing, the relevant lead is not doing its card job; rewrite it and re-ingest that page with `--overwrite`. For large ingests, `assistant memory v3 eval` can additionally gate the change, but it is a two-corpus comparison requiring `--snapshot`, `--staging`, and `--out`; use it only when you captured a pre-ingest snapshot of `memory/concepts/` to compare against. Otherwise the query checks above are the verification.

## Hard rules

- Raw corpus content never enters `memory/concepts/` or `memory/buffer.md`. Map pages only, via `assistant memory ingest`.
- The cold store lives under `imports/<source>/` and is read-only after landing.
- Map size is 10 to 50 pages regardless of corpus size.
- Drill-in pointers (the `Raw data:` line) live in the page lead, because the card renderer injects the lead plus a section list; a pointer buried in a section is invisible at routing time.
- `origin_date:` is the content's own date, never the import date.
- Skim fan-out is bounded by the slice plan; one pass per slice, a few in flight at a time.
- Always dry-run the ingest before the real run.

## References

- `references/map-page-template.md`: the exact article shape for map pages, with a full example. Read before writing any staged page.
- `references/fathom.md`: Fathom recording archives specifically; export discovery, speaker and date extraction, slicing, and what belongs in the map versus the cold store.
