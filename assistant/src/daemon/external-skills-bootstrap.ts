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
 *
 * ## Lazy-external meet-host path (behind `services.meet.host.lazy_external`)
 *
 * The flag defaults to `false`, so by default the bootstrap still runs
 * the statically-imported `register(host)` path above — behavior is
 * identical to pre-isolation main. When the flag flips to `true`
 * (PR 32), the bootstrap instead constructs a {@link MeetHostSupervisor},
 * wires it into the session-reporting IPC routes, and installs proxy
 * tools/routes via the manifest loader so the meet-host child process
 * spawns lazily on first meet use. The sanctioned-exception rationale
 * above still holds for the static `register` import — the flag just
 * switches between two load paths, it does not eliminate this file's
 * role as the single in-process entry.
 */

import { register as registerMeet } from "../../../skills/meet-join/register.js";
import { getConfig, getNestedValue } from "../config/loader.js";
import { setMeetHostSupervisorForSessionReports } from "../ipc/skill-routes/registries.js";
import { getRepoSkillsDir } from "../skills/catalog-install.js";
import { getLogger } from "../util/logger.js";
import { getBundledBunPath, getSkillRuntimePath } from "../util/platform.js";
import { createDaemonSkillHost } from "./daemon-skill-host.js";
import { MeetHostSupervisor } from "./meet-host-supervisor.js";
import {
  loadMeetManifestFromDisk,
  loadMeetManifestProxies,
  resolveMeetManifestPath,
} from "./meet-manifest-loader.js";

const log = getLogger("external-skills-bootstrap");

const LAZY_EXTERNAL_CONFIG_KEY = "services.meet.host.lazy_external";

function readLazyExternalFlag(): boolean {
  try {
    const raw = getNestedValue(
      getConfig() as unknown as Record<string, unknown>,
      LAZY_EXTERNAL_CONFIG_KEY,
    );
    return raw === true;
  } catch (err) {
    log.warn(
      { err, configKey: LAZY_EXTERNAL_CONFIG_KEY },
      "Failed to read lazy-external flag; defaulting to in-process path",
    );
    return false;
  }
}

async function startLazyExternalMeetHost(): Promise<void> {
  const skillsRoot = getRepoSkillsDir();
  const skillRuntime = getSkillRuntimePath("meet-join", skillsRoot);
  const manifestPath = resolveMeetManifestPath();
  if (!skillRuntime || !manifestPath) {
    throw new Error(
      "Lazy-external meet-host path requires a shipped meet-join skill runtime. " +
        "Rebuild/repackage so first-party skills ship with the daemon.",
    );
  }
  const manifest = loadMeetManifestFromDisk(manifestPath);
  const bunBinary = getBundledBunPath() ?? "bun";
  const supervisor = new MeetHostSupervisor({
    skillRuntimePath: skillRuntime,
    bunBinaryPath: bunBinary,
    manifest: { sourceHash: manifest.sourceHash },
  });
  setMeetHostSupervisorForSessionReports(supervisor);
  await loadMeetManifestProxies(supervisor, { manifestPath });
  log.info(
    { skillRuntime, manifestPath },
    "meet-join registered via lazy-external path",
  );
}

if (readLazyExternalFlag()) {
  // Lazy-external path. PR 32 flips the default; for now this branch is
  // opt-in so `services.meet.host.lazy_external = true` in user config
  // exercises the full manifest/supervisor flow end-to-end.
  void startLazyExternalMeetHost().catch((err) => {
    log.error(
      { err },
      "Failed to register meet-join via lazy-external path; daemon will continue without meet tools",
    );
  });
} else {
  // Default: in-process path, unchanged. The statically-imported named
  // `register` above is how `bun --compile` pulls the skill source into
  // the binary. See the module header for why this import is the single
  // sanctioned exception to the skill-boundary rule.
  registerMeet(createDaemonSkillHost("meet-join"));
}
