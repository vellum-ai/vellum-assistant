/**
 * External skill bootstrap.
 *
 * Loads first-party skills that expose **in-process tools** to the daemon.
 * Each skill exports a `register(host)` function that installs its tools,
 * routes, and shutdown hooks into the daemon's registries; this module
 * builds a `DaemonSkillHost` for every bundled skill and calls its
 * `register` exactly once at daemon startup.
 *
 * ## Why the cross-directory import exists
 *
 * `CLAUDE.md` and `skills/meet-join/AGENTS.md` establish a general rule
 * that `assistant/` must not import from `skills/` via relative paths so
 * that skills stay portable and extractable. For in-process tools this
 * creates a chicken-and-egg problem: skills need their `register` to
 * execute before `initializeTools()` runs, but in a `bun --compile`
 * binary only statically analyzed imports end up in the bundle, and
 * dynamic imports with variable paths fail inside `/$bunfs/`.
 *
 * We resolve the tension by:
 *
 *   1. Keeping this file as the **one** place in `assistant/` that
 *      reaches into `skills/`. Every other import direction (skill ->
 *      assistant) goes through the `SkillHost` contract in
 *      `@vellumai/skill-host-contracts` instead of relative paths.
 *   2. Limiting entries to **first-party bundled skills** whose source
 *      is shipped in the Docker build context and statically compiled
 *      into the Bun binary. The repo-root `.dockerignore` is the
 *      allowlist that determines which skill files enter the build
 *      context; the assistant `Dockerfile` copies `skills/` generically.
 *   3. Importing only a named `register` function per skill and
 *      invoking it with a freshly built `DaemonSkillHost`. The skill
 *      owns both the tool list and the feature-flag semantics — this
 *      file just wires the registration call into the startup path.
 *
 * When a new bundled first-party skill wants to expose in-process
 * tools to the LLM, add another named `register` import + call here
 * and extend the repo-root `.dockerignore` allowlist with the skill's
 * runtime files. Non-bundled skills (workspace-installed, third-party)
 * never belong in this file.
 */

import { register as registerMeet } from "../../../skills/meet-join/register.js";
import { createDaemonSkillHost } from "./daemon-skill-host.js";

registerMeet(createDaemonSkillHost("meet-join"));
