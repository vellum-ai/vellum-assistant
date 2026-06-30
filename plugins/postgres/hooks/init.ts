/**
 * Ensures a PostgreSQL installation is present on PATH before the plugin does
 * anything else. PostgreSQL is the database backend this plugin manages, so a
 * missing install is a hard stop: the hook throws, the loader raises
 * PluginExecutionError, and bootstrap for this plugin aborts loudly rather than
 * leaving a half-wired backend.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InitContext } from "@vellumai/plugin-api";

const execFileAsync = promisify(execFile);

// Entry points shipped by a PostgreSQL install. Probing several covers distro
// layouts that package the server (`postgres`, `pg_ctl`) separately from the
// client (`psql`).
const POSTGRES_BINARIES = ["pg_ctl", "postgres", "psql"] as const;

/** Returns the binary's `--version` output, or `null` if it isn't runnable. */
async function probeVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export default async function init(ctx: InitContext): Promise<void> {
  for (const binary of POSTGRES_BINARIES) {
    const version = await probeVersion(binary);
    if (version !== null) {
      ctx.logger.info({ binary, version }, "postgresql detected");
      return;
    }
  }

  throw new Error(
    `postgresql is not installed: none of ${POSTGRES_BINARIES.join(", ")} ` +
      `responded to --version on PATH. Install PostgreSQL before enabling the ` +
      `postgres plugin.`,
  );
}
