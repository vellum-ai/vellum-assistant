# Bundled Skills — Agent Instructions

## Tool Executors

A tool executor referenced by a bundled skill's `TOOLS.json` (`"executor": "tools/<name>.ts"`) needs no registration step. Bundled skills ship as real files alongside the binary (resolved by `getBundledSkillsDir()` in `src/config/skills.ts`), and the skill script runner dynamically imports the executor from that directory at call time — this works in compiled builds because the files live on disk, not inside `/$bunfs/`. `knip` treats `src/config/bundled-skills/**/tools/**/*.ts` as entry points (see `knip.json`), so executors are not flagged as unused despite having no static importer.

Each executor is a module exporting `run(input, context)` (the `SkillToolScript` contract in `src/tools/skills/script-contract.ts`). Bundled executors declared `execution_target: "host"` run in the daemon process with the full `ToolContext` — including request-bound fields like `proxyToolResolver`.

## Keeping public docs in sync

A bundled skill's `SKILL.md` is its behavioral source of truth. Skills with a public reference page (`https://www.vellum.ai/docs/skills-reference/<slug>`, authored in the **vellum-assistant-platform** repo) are fingerprinted in `scripts/skill-docs-sync.manifest.json` and enforced by `skill-docs-sync-guard.test.ts`.

When you change a documented skill's `SKILL.md`, the guard fails until you reconcile it:

1. Review the named docs page and update it if the behavior changed.
2. Re-record the fingerprint to acknowledge it: `bun run scripts/check-skill-docs-sync.ts --write`.

The fingerprint bump is the acknowledgement — even a trivial wording edit requires one. When a bundled skill **gains** a public docs page, add an entry to the manifest.
