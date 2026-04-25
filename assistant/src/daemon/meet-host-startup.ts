/**
 * Meet-host startup.
 *
 * Loads the meet-join skill via its lazy-external path: read the shipped
 * manifest from disk, install proxy tools/routes/shutdown-hooks into the
 * daemon's registries, and stand up a `MeetHostSupervisor` that spawns
 * the meet-host child process on first invocation.
 *
 * The daemon does not import any code from `skills/` here. The skill runs
 * as a separate `bun run` subprocess and communicates with the daemon
 * over the skill IPC socket. The proxy tools/routes the daemon installs
 * dispatch to that subprocess via bidirectional RPC.
 */

import { setMeetHostSupervisorForSessionReports } from "../ipc/skill-routes/registries.js";
import { getRepoSkillsDir } from "../skills/catalog-install.js";
import { getLogger } from "../util/logger.js";
import { getBundledBunPath, getSkillRuntimePath } from "../util/platform.js";
import { MeetHostSupervisor } from "./meet-host-supervisor.js";
import {
  loadMeetManifestFromDisk,
  loadMeetManifestProxies,
  resolveMeetManifestPath,
} from "./meet-manifest-loader.js";

const log = getLogger("meet-host-startup");

export async function startMeetHost(): Promise<void> {
  const skillsRoot = getRepoSkillsDir();
  const skillRuntime = getSkillRuntimePath("meet-join", skillsRoot);
  const manifestPath = resolveMeetManifestPath();
  if (!skillRuntime || !manifestPath) {
    throw new Error(
      "meet-host startup requires a shipped meet-join skill runtime. " +
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
    "meet-join registered via meet-host startup",
  );
}
