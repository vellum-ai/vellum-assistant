/**
 * Installs standalone CLI launcher scripts in ~/.vellum/bin/ so that
 * integration commands (e.g. `doordash`, `map`) can be invoked directly
 * without requiring `vellum` on PATH.
 *
 * Each launcher is a shell script that hardcodes absolute paths to `bun`
 * and the CLI entrypoint, forwarding all arguments to the appropriate
 * subcommand.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../util/logger.js';

const log = getLogger('install-cli-launchers');

/** Integration subcommands that should get standalone launchers. */
const INTEGRATION_COMMANDS = ['doordash', 'map'];

/**
 * Resolve the absolute path to the bun binary.
 * Prefers process.execPath (works when running under bun), then falls
 * back to `which bun`.
 */
function resolveBunPath(): string {
  // process.execPath points to the bun binary when running under bun
  if (process.execPath && process.execPath.includes('bun')) {
    return process.execPath;
  }
  try {
    return execSync('which bun', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Could not find bun binary');
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
  return join(thisDir, '..', 'index.ts');
}

/**
 * Check whether a given command name conflicts with an existing system
 * binary (i.e. something other than our own launcher).
 */
function hasSystemConflict(name: string, binDir: string): boolean {
  try {
    const result = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
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
 * bun with the CLI entrypoint and the subcommand name prepended.
 * Uses the short name by default (e.g. `doordash`), falling back to
 * `vellum-<name>` if the short name conflicts with an existing system binary.
 */
export function installCliLaunchers(): void {
  const binDir = join(homedir(), '.vellum', 'bin');

  let bunPath: string;
  try {
    bunPath = resolveBunPath();
  } catch (err) {
    log.warn({ err }, 'Cannot install CLI launchers: bun not found');
    return;
  }

  const entrypoint = resolveCliEntrypoint();
  if (!existsSync(entrypoint)) {
    log.warn({ entrypoint }, 'Cannot install CLI launchers: CLI entrypoint not found');
    return;
  }

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  for (const name of INTEGRATION_COMMANDS) {
    const launcherName = hasSystemConflict(name, binDir) ? `vellum-${name}` : name;
    const launcherPath = join(binDir, launcherName);

    const script = `#!/bin/bash
exec ${bunPath} ${entrypoint} ${name} "$@"
`;

    writeFileSync(launcherPath, script);
    chmodSync(launcherPath, 0o755);
    log.debug({ launcherName, launcherPath }, 'Installed CLI launcher');
  }

  log.info({ binDir, commands: INTEGRATION_COMMANDS }, 'CLI launchers installed');
}
