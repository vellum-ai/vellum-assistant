# evals/ — Personal-Intelligence Benchmark Harness

## Purpose

Decision instrument for plugin-shipping decisions on Vellum Assistant. Runs profiles (species + setup + initial workspace) against personal-intelligence tests, generates reports, drives product decisions.

Secondary: competitive benchmarking against OpenClaw, Claude Code, Codex, and Hermes via the same harness.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Scope

- OSS-from-day-one. Nothing here stays private.
- Native TypeScript. No upstream eval framework dependency; borrows Solver/Scorer/Task patterns from inspect-ai.
- Cost is a first-class scoring axis (tokens + API spend + latency).
- Local-dev-only sandbox; `qa.vellum.ai` hosting comes later.

## Architecture

**Run shape, parameterized cartesian:**

```
evals run --profiles <p1>[,<p2>...] --tests <t1>[,<t2>...]
```

Single (1×1), suite (1×M), ablation (N×1), full matrix (N×M). Same codepath.

**Profile:** declarative directory under `profiles/`. `manifest.json` declares species, optional version, optional setup commands. Optional `workspace/` subdirectory provides initial files for the agent. Plugins are installed via setup commands like `vellum exec -- assistant plugins install simple-memory`.

**Test:** declarative directory under `tests/`. `SPEC.md` briefs the simulator agent. Optional `metrics/` subdirectory holds per-metric `.ts` scorers.

**Agent adapter (per species):** thin CLI process wrapper. Owns invocation, stdin/stdout format, session resume, cost extraction. Each test gets a fresh process — no sharing across tests (parallelization-ready).

**Simulator:** LLM-driven user (Claude Haiku). Same model across all tests and species; represents any-possible-user generality. Seeded for pseudo-determinism.

**Egress jail:** Docker network layer. All network blocked by default; allow-list for known LLM provider endpoints. Integrations mocked.

**Report card:** JSONL — one row per (profile × test × run). Static HTML report rendered alongside.

## Conventions

- **CLI entry:** `src/cli.ts`. Subcommands live in `src/commands/<name>.ts` and export `register<Name>Command(program)` (commander). New subcommands register themselves on the root program in `cli.ts`.
- **Public module API:** `src/index.ts`. Importing the package root never runs the CLI.
- **Schemas:** zod, co-located with their loader in `src/lib/*.ts`.
- **Profile/Test ids:** lowercase alphanumeric + hyphens (`^[a-z0-9][a-z0-9-]*$`). Match the directory name.
- **Environment:** `.env` (gitignored) — copy from `.env.example`.
- **Test fixtures:** committed in-repo for reproducibility.
- **Each test runs in its own fresh agent process.** No sharing — parallelization-ready by construction.

## What does NOT belong here

- Vellum runtime code, plugin sources, skill definitions — those live in `assistant/`, `experimental/plugins/`, `skills/`.
- CI infrastructure or release tooling — this is a sandbox-only harness.
- Anything not directly serving the "run a profile × test combo and emit a report row" mission.
