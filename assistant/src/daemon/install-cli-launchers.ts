/**
 * Installs standalone CLI launcher scripts in ~/.vellum/bin/ so that
 * integration commands (e.g. `map`) can be invoked directly without
 * requiring `vellum` on PATH.
 *
 * Each launcher is a shell script that hardcodes absolute paths to `bun`
 * and the CLI entrypoint, forwarding all arguments to the appropriate
 * subcommand.
 *
 * Commands are split into two categories:
 * - CORE_COMMANDS: always installed, dispatched via the main CLI entrypoint
 * - Skill CLI launchers: dynamically discovered from installed skills that
 *   declare a `cli` entry in their SKILL.md frontmatter metadata
 */

import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSkillCatalog } from "../skills/catalog.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("install-cli-launchers");

/** Core subcommands dispatched via the main CLI entrypoint (index.ts). */
const CORE_COMMANDS = ["map"];

/**
 * Resolve the absolute path to the bun binary.
 * Prefers process.execPath (works when running under bun), then falls
 * back to `which bun`.
 */
function resolveBunPath(): string {
  // process.execPath points to the bun binary when running under bun
  if (process.execPath && process.execPath.includes("bun")) {
    return process.execPath;
  }
  try {
    return execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Could not find bun binary");
  }
}

/**
 * Resolve the absolute path to the CLI entrypoint (index.ts).
 * Uses import.meta.dirname to find the source tree root.
 */
function resolveCliEntrypoint(): string {
  // This file is at assistant/src/daemon/install-cli-launchers.ts
  // The CLI entrypoint is at assistant/src/index.ts
  const thisDir = import.meta.dirname ?? __dirname;
  return join(thisDir, "..", "index.ts");
}

/**
 * Check whether a given command name conflicts with an existing system
 * binary (i.e. something other than our own launcher).
 */
function hasSystemConflict(name: string, binDir: string): boolean {
  try {
    const result = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    // If `which` resolves to our own bin dir, that's not a conflict
    if (result.startsWith(binDir)) return false;
    return true;
  } catch {
    // `which` failed — no conflict
    return false;
  }
}

/**
 * Install standalone CLI launcher scripts in ~/.vellum/bin/.
 *
 * For each integration command, generates a shell script that execs
 * bun with the appropriate entrypoint.
 * Uses the short name by default (e.g. `doordash`), falling back to
 * `vellum-<name>` if the short name conflicts with an existing system binary.
 *
 * Skill CLI launchers are discovered dynamically: any installed skill whose
 * SKILL.md frontmatter declares `metadata.vellum.cli` will get a launcher
 * pointing to the declared entry file within the skill directory.
 */
export function installCliLaunchers(): void {
  const binDir = join(homedir(), ".vellum", "bin");

  let bunPath: string;
  try {
    bunPath = resolveBunPath();
  } catch (err) {
    log.warn({ err }, "Cannot install CLI launchers: bun not found");
    return;
  }

  const mainEntrypoint = resolveCliEntrypoint();
  if (!existsSync(mainEntrypoint)) {
    // In compiled builds (e.g. macOS app via `bun build --compile`), the
    // source tree isn't available.  Launcher scripts are a dev-mode
    // convenience; compiled builds use their own command dispatch, so we
    // silently skip installation.
    log.debug(
      { entrypoint: mainEntrypoint },
      "CLI entrypoint not found (compiled build?) — skipping launcher installation",
    );
    return;
  }

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const installed: string[] = [];

  // Install core command launchers (dispatched via main CLI)
  for (const name of CORE_COMMANDS) {
    const launcherName = hasSystemConflict(name, binDir)
      ? `vellum-${name}`
      : name;
    const launcherPath = join(binDir, launcherName);

    const script = `#!/bin/bash
exec "${bunPath}" "${mainEntrypoint}" ${name} "$@"
`;

    writeFileSync(launcherPath, script);
    chmodSync(launcherPath, 0o755);
    installed.push(launcherName);
    log.debug({ launcherName, launcherPath }, "Installed core CLI launcher");
  }

  // Discover and install skill CLI launchers from the skill catalog
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      const cli = skill.metadata?.cli;
      if (!cli?.command || !cli?.entry) continue;

      const entrypoint = join(skill.directoryPath, cli.entry);
      if (!existsSync(entrypoint)) {
        log.debug(
          { skillId: skill.id, entrypoint },
          "Skill CLI entry point not found — skipping",
        );
        continue;
      }

      const launcherName = hasSystemConflict(cli.command, binDir)
        ? `vellum-${cli.command}`
        : cli.command;
      const launcherPath = join(binDir, launcherName);

      const script = `#!/bin/bash
exec "${bunPath}" "${entrypoint}" "$@"
`;

      writeFileSync(launcherPath, script);
      chmodSync(launcherPath, 0o755);
      installed.push(launcherName);
      log.debug(
        { launcherName, launcherPath, skillId: skill.id },
        "Installed skill CLI launcher",
      );
    }
  } catch (err) {
    log.warn({ err }, "Failed to discover skill CLI launchers");
  }

  log.info({ binDir, commands: installed }, "CLI launchers installed");
}
