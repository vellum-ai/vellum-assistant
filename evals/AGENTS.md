# evals/ — Personal-Intelligence Benchmark Harness

## Purpose

Decision instrument for plugin-shipping decisions on Vellum Assistant. Runs profiles (species + plugin combinations + initial state) against personal-intelligence tests, generates reports, drives product decisions.

Secondary: competitive benchmarking against OpenClaw, Claude Code, Codex, and Hermes via the same harness.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Scope

- OSS-from-day-one. Nothing here stays private.
- Native TypeScript. No upstream eval framework dependency; borrows Solver/Scorer/Task patterns from inspect-ai.
- Cost is a first-class scoring axis (tokens + API spend + latency).
- Local-dev-only for v0.1. `qa.vellum.ai` hosting comes later.

## Architecture

**Run shape, parameterized cartesian:**

```
evals run --profiles <p1>[,<p2>...] --tests <t1>[,<t2>...]
```

Single (1×1), suite (1×M), ablation (N×1), full matrix (N×M). Same codepath.

**Profile:** the unit of plugin + species variation. Declarative JSON in `profiles/`.

**Test definition:** declarative JSON in `tests/`. Slug format `<domain>.<shape>.<name>` (e.g. `mem.single_turn.timeline_recall`).

**Agent adapter (per species):** thin CLI process wrapper. Owns invocation, stdin/stdout format, session resume, cost extraction. Each test gets a fresh process — no sharing across tests (parallelization-ready).

**Simulator:** LLM-driven user (Claude Haiku). Same model across all tests and species; represents any-possible-user generality. Seeded for pseudo-determinism.

**Egress jail:** Docker network layer. All network blocked by default; allow-list for known LLM provider endpoints. Integrations mocked.

**Report card:** JSONL — one row per (profile × test × run). Static HTML report rendered alongside.

## Build status

v0.1 build-out (in flight):

- **PR-1 (this PR):** package scaffold + Profile/Test Zod schemas + loaders + one example profile + one stub test definition. No execution path.
- **PR-2:** Vellum agent adapter (`vellum events` long-lived stdout pipe per fresh process) + Docker-network-mediated egress jail.
- **PR-3:** Haiku-backed simulator + Test 1 (`mem.single_turn.timeline_recall`) + harness orchestrator → first observable run.
- **PR-4:** Static HTML report (Playwright-reporter shape).

See `memory/concepts/workstreams/everything-is-a-skill.md` and `scratch/evals-plan-v2.md` (in the ApolloBot workspace) for the full plan.

## Conventions

- **Commands** live in `src/commands/`, standalone exported functions; argv parsing via `node:util` `parseArgs`.
- **Schemas** live in `src/lib/*.ts` using Zod; loaders are co-located with their schema.
- **Unit tests** live in `src/**/__tests__/*.test.ts`.
- **Test definitions** and **fixtures** are committed JSON for reproducibility.
- **Environment** lives in `.env` (gitignored) — copy from `.env.example`.
- **Profile IDs** match filenames in `profiles/<id>.json`; **test IDs** match `tests/<id>.json`.
- **Each test runs in its own fresh agent process.** No sharing — parallelization-ready by construction.

## What does NOT belong here

- Vellum runtime code, plugin sources, skill definitions — those live in `assistant/`, `experimental/plugins/`, `skills/`.
- CI infrastructure or release tooling — this is a sandbox-only harness.
- Anything not directly serving the "run a profile × test combo and emit a report row" mission.
