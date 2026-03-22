import { exec } from "./step-runner";

/**
 * Best-effort git commit in a workspace directory.
 *
 * Stages all changes and creates an `--allow-empty` commit so the
 * history records every upgrade/rollback even when no files changed.
 *
 * Safety measures (mirroring WorkspaceGitService in the assistant package):
 * - Deterministic committer identity (`vellum-cli`)
 * - Hooks disabled (`core.hooksPath=/dev/null`, `--no-verify`)
 *
 * Callers should wrap this in try/catch — failures must never block
 * the upgrade or rollback flow.
 */
export async function commitWorkspaceState(
  workspaceDir: string,
  message: string,
): Promise<void> {
  const opts = { cwd: workspaceDir };
  await exec("git", ["add", "-A"], opts);
  await exec(
    "git",
    [
      "-c",
      "user.name=vellum-cli",
      "-c",
      "user.email=cli@vellum.ai",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--no-verify",
      "--allow-empty",
      "-m",
      message,
    ],
    opts,
  );
}
