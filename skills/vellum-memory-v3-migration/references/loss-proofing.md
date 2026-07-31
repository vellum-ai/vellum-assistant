# Loss-proofing contract

You are rewriting memory that cannot be regenerated. Loss-proof is a property you **verify**, not one you intend. Every stage obeys this contract.

## The three trees

| Tree                      | Role               | Rule                                                       |
| ------------------------- | ------------------ | ---------------------------------------------------------- |
| `memory/concepts/` (live) | the safety net     | **never edited until cutover** (SKILL.md Step 9)           |
| `.mv3/snapshot/concepts/` | read-only baseline | the audit comparator + eval comparator — **never written** |
| `.mv3/staging/`           | the work           | all authoring writes here                                  |

Plus `.mv3/provenance/` (per-cluster source maps), `.mv3/audit/` (drop reports, dangling links), `.mv3/eval/` (packets, verdicts). `.mv3/` is git-tracked in the workspace so every milestone is a recoverable commit; the snapshot copy is belt-and-suspenders on top of git.

## Provenance is mandatory

Every staged article records the snapshot paths it consumed: `.mv3/provenance/<cluster>.json` = `[{ slug, sources: [...] }]`. Provenance is what makes loss measurable and the reform reversible. An article with no provenance cannot be audited and must not ship.

## The drop-check (mechanical, must be clean)

Every path in `.mv3/snapshot/concepts/` must appear as a `source` in some staged article's provenance, **or** under an explicit `unrouted` bucket. Build the set of all snapshot paths, subtract the set of all provenance sources, and the remainder must be empty (or knowingly `unrouted`). A silently missing path is a silently lost page. A tiny stdlib script does this — no `yaml` module in the sandbox, so parse frontmatter by hand or operate on raw paths.

## The quote-screen (mechanical)

For each staged article, extract quoted strings, dates, and numbers from its provenance sources and confirm each appears in the article body (frontmatter stripped). Misses are candidate drops for the semantic pass to confirm. A byte-ratio sanity check helps: if a staged cluster is far smaller than the union of its sources (e.g. < 0.7×), that's a compression tell — investigate before trusting it. Relocation should roughly conserve or expand, not shrink.

## The semantic pass (reader panel)

The mechanical checks catch missing strings; they miss _weakened_ substance (a passage flattened, an implication dropped). The reader-panel workflow (`workflows.md` §2) reads source-vs-staged in full and tags drops `[load-bearing]` / `[secondary]` / `[incidental]`. **Patch every `[load-bearing]` drop back verbatim** into the right section. `[secondary]`/`[incidental]` are judgment calls — patch when cheap, record when not.

## Review gate

No fan-out leaf marks an article as final. Authoring leaves write `status: draft`. You flip `draft → final` yourself in Step 7, reading content that the audit has already proven whole. This editorial sign-off is the assistant's own call.

## Recovery

- Mid-run interruption (crash, deploy): the authoring workflow's resume replays completed clusters; re-launch the same `run_workflow` with the same `args`.
- Bad cutover: `.mv3/backup-concepts.<timestamp>/` is the rollback point. `rsync -a --delete` it back over `memory/concepts/`, then `assistant config set memory.v3.live false`; the restored triggers run v2-shape consolidation on the restored corpus. Keep the backup and snapshot until the user confirms the live wiki is good.
- Nothing is deleted on the live side until the user confirms — archive, never delete.
