/**
 * Memory v2 — consolidation prompt template.
 *
 * Body copied verbatim from §10 of the design doc
 * (`memoized-spinning-wadler.md`). The consolidation job calls
 * `wakeAgentForOpportunity()` so the assistant runs with its full system
 * prompt + tool surface; the text below is supplied as the wake hint.
 *
 * The single placeholder `{{CUTOFF}}` is substituted at runtime with an
 * ISO-8601 timestamp captured at job dispatch. Anything appended to
 * `memory/buffer.md` after that timestamp is the next pass's problem.
 *
 * Kept under `prompts/` rather than inlined in `consolidation-job.ts` so the
 * prompt body is reviewable on its own and the job module stays focused on
 * orchestration (lock file, wake invocation, follow-up enqueues). Mirrors
 * the convention established for the sweep prompt in PR 18.
 */

/** Sentinel substituted with the cutoff timestamp at runtime. */
export const CUTOFF_PLACEHOLDER = "{{CUTOFF}}";

/**
 * Consolidation prompt — body from design doc §10. The agent runs as itself
 * (full SOUL.md + IDENTITY.md + persona + memory autoloads) with the standard
 * tool surface, and is asked to route buffer entries into concept pages,
 * rewrite recent.md, promote essentials/threads, and trim the buffer.
 *
 * The prompt is intentionally directive about timing semantics: anything
 * timestamped at or after `{{CUTOFF}}` arrived AFTER the run started and
 * must be left for the next pass. This keeps multiple consolidation runs
 * idempotent under append-only writers (remember(), sweep job).
 */
export const CONSOLIDATION_PROMPT = `You are running memory consolidation. The buffer (\`memory/buffer.md\`) holds new things you've remembered since the last pass. Your job: route them into the right pages, rewrite \`memory/recent.md\`, trim the buffer.

Cutoff timestamp for this run: \`${CUTOFF_PLACEHOLDER}\`. Anything in \`memory/buffer.md\` with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\` arrived AFTER you started — leave it for the next pass.

**Process:**

1. Read \`memory/buffer.md\`. List existing pages with \`ls memory/concepts/\`.

2. For each entry with timestamp < \`${CUTOFF_PLACEHOLDER}\`:
   - Identify what concept(s) it touches. Duplication is expected — if a fact is relevant to multiple concepts, write it into all of them.
   - Decide where it goes:
     - **Existing concept page** → append/rewrite the relevant section, conservatively. Don't restructure pages that aren't touched.
     - **New concept worth its own page** → create \`memory/concepts/<slug>.md\` with the schema below. Add bidirectional edges to related existing pages by editing \`memory/edges.json\`.
     - **Recent ephemeral state** → goes into \`memory/recent.md\`, not a permanent page.

   Schema:
   \`\`\`yaml
   ---
   edges: [slug-1, slug-2]      # will be regenerated from edges.json; you can leave empty
   ref_files: []
   ---
   [Prose body, first-person, in your voice. NOT a timestamped list of events.]
   \`\`\`

   Concept pages should be edited and rewritten as needed, not treated as append-only.

3. **Edges** (\`memory/edges.json\`): when an entry binds two concepts, append \`[slug-a, slug-b]\` (alphabetical-first first). The frontmatter view will be regenerated later by backfill — don't hand-edit page frontmatter.

4. **Page size**: after edits, \`wc -m memory/concepts/<changed-files>\`. If any > 5000 chars, decide:
   - **Compress** — rewrite tighter, keep load-bearing facts.
   - **Split** — create new page(s), update edges.

5. **\`memory/recent.md\`**: rewrite as a fresh ≤1000-token prose narrative of the last few hours, latest first. Compact older items into one-liners or drop them.

6. **\`memory/essentials.md\`**: facts that MUST be loaded at all times — things that would be embarrassing to forget on the next conversation. Examples: the user's name, current employment, ongoing health context, immediate family/relationship configuration, fundamental long-running preferences. Promote new essentials in; demote stale ones out (move to a concept page).

7. **\`memory/threads.md\`**: active commitments and follow-ups. Examples: "follow up on the contract review next Tuesday," "user said they'd send the design doc — check Thursday if not received," "user is debating whether to switch jobs, expects to decide by end of month." Close threads when the underlying commitment resolves; promote stable outcomes to a concept page or essentials.

8. **Trim \`memory/buffer.md\`**:
   - Re-read the buffer (it may have new entries appended during your work).
   - Rewrite to contain ONLY entries with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\`.
   - Smart removal — never wholesale-clear.

You are rewriting your own memory. Care, judgment, voice. This is the engine that decides who you are tomorrow.`;

/**
 * Resolve `CONSOLIDATION_PROMPT` with `{{CUTOFF}}` substituted. The cutoff
 * format is the caller's choice — the prompt treats it as opaque text and
 * uses string comparison, so any total-order timestamp format works (ISO-8601
 * is the convention).
 */
export function renderConsolidationPrompt(cutoff: string): string {
  return CONSOLIDATION_PROMPT.replaceAll(CUTOFF_PLACEHOLDER, cutoff);
}
