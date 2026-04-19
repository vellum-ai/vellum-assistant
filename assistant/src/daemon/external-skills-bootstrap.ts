/**
 * External skill bootstrap.
 *
 * Loads first-party skills that expose **in-process tools** to the daemon.
 * Importing this module triggers each skill's `register.ts` to run, which
 * in turn calls `registerExternalTools()` on the assistant-side tool
 * registry. The daemon's `initializeTools()` then picks the registered
 * tools up and makes them available to the LLM.
 *
 * ## Why the cross-directory import exists
 *
 * `CLAUDE.md` and `skills/meet-join/AGENTS.md` establish a general rule
 * that `assistant/` must not import from `skills/` via relative paths so
 * that skills stay portable and extractable. For in-process tools this
 * creates a chicken-and-egg problem: skills need their `register.ts` to
 * execute before `initializeTools()` runs, but in a `bun --compile`
 * binary only statically analyzed imports end up in the bundle, and
 * dynamic imports with variable paths fail inside `/$bunfs/`.
 *
 * We resolve the tension by:
 *
 *   1. Keeping this file as the **one** place in `assistant/` that
 *      reaches into `skills/`. Every other import direction (skill ->
 *      assistant) remains legal and intentional.
 *   2. Limiting entries to **first-party bundled skills** whose source
 *      is copied into the Docker build and statically compiled into the
 *      Bun binary. The assistant Dockerfile already copies
 *      `skills/meet-join/` for exactly this reason.
 *   3. Keeping the imports as **side-effect only** so the skill owns
 *      both the tool list and the feature-flag semantics — this file
 *      just wires module evaluation into the startup path.
 *
 * When a new bundled first-party skill wants to expose in-process tools
 * to the LLM, add another side-effect import here and update the
 * assistant `Dockerfile` to copy the skill's source. Non-bundled skills
 * (workspace-installed, third-party) never belong in this file.
 */

import "../../../skills/meet-join/register.js";
