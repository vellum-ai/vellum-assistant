/**
 * Silent auto-install for known ACP adapter binaries.
 *
 * When a spawn fails preflight with `binary_not_found`, callers (the
 * `acp_spawn` tool and the `/v1/acp/spawn` route) call
 * `resolveAgentWithAutoInstall(agentId)`, which tries a global npm install
 * of the mapped adapter package, then re-resolves and continues. On failure
 * they fall back to the existing actionable install hint.
 *
 * Security boundary: only commands present in `DEFAULT_AGENT_NPM_PACKAGES`
 * are ever installed. The package names are vendored constants, NOT user
 * input: an arbitrary command from user config must never be turned into
 * an `npm i -g <attacker-controlled-name>` execution.
 */

import { execFile } from "node:child_process";

import { DEFAULT_AGENT_NPM_PACKAGES } from "../config/acp-defaults.js";
import { getLogger } from "../util/logger.js";
import {
  resolveAcpAgent,
  type ResolveAcpAgentResult,
} from "./resolve-agent.js";

const log = getLogger("acp:auto-install");

/** Per-install timeout for `npm i -g`. Generous: cold npm caches are slow. */
const NPM_INSTALL_TIMEOUT_MS = 120_000;

export interface AdapterInstallResult {
  installed: boolean;
  error?: string;
}

/**
 * Per-command install promises. Concurrent spawns for the same missing
 * binary dedupe to a single `npm i -g`; successful results are cached for
 * the process lifetime. Failed installs are evicted so a later spawn can
 * retry (e.g. after the user fixes network or npm permissions).
 */
const installPromises = new Map<string, Promise<AdapterInstallResult>>();

/**
 * Run `execFile` with an AbortController-driven timeout. Returns the stdout
 * on success; throws on error or timeout. Shared by the adapter installer
 * here and the version probes in `tools/acp/spawn.ts`.
 */
export function execFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    execFile(
      command,
      args,
      { signal: controller.signal, encoding: "utf8" },
      (err, stdout) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Install the npm package mapped to `command` if (and only if) the command
 * is a known adapter binary. Unknown commands resolve to
 * `{ installed: false }` without ever invoking npm (see the security
 * boundary note in the module doc).
 */
export function ensureAdapterInstalled(
  command: string,
): Promise<AdapterInstallResult> {
  const packageName = DEFAULT_AGENT_NPM_PACKAGES[command];
  if (!packageName) {
    return Promise.resolve({ installed: false });
  }

  const inFlight = installPromises.get(command);
  if (inFlight) return inFlight;

  const promise = runInstall(command, packageName).then((result) => {
    if (!result.installed) installPromises.delete(command);
    return result;
  });
  installPromises.set(command, promise);
  return promise;
}

async function runInstall(
  command: string,
  packageName: string,
): Promise<AdapterInstallResult> {
  log.info({ command, packageName }, "Auto-installing missing ACP adapter");
  try {
    await execFileWithTimeout(
      "npm",
      ["i", "-g", packageName],
      NPM_INSTALL_TIMEOUT_MS,
    );
    log.info({ command, packageName }, "ACP adapter auto-install succeeded");
    return { installed: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, command, packageName },
      "ACP adapter auto-install failed (falling back to install hint)",
    );
    return { installed: false, error };
  }
}

export interface ResolveWithAutoInstallResult {
  /** The final resolver outcome (post-install re-resolve when applicable). */
  resolved: ResolveAcpAgentResult;
  /** Set when a missing adapter binary was silently installed via npm. */
  autoInstalledPackage?: string;
  /**
   * Set when the auto-install itself failed: the original install hint
   * augmented with the npm failure reason. Callers should surface this
   * instead of re-deriving a message from `resolved`.
   */
  failureMessage?: string;
}

/**
 * Resolve an ACP agent id, silently auto-installing the mapped adapter
 * package when (and only when) the failure is a missing allowlisted binary.
 * Shared by the `acp_spawn` tool and the `/v1/acp/spawn` route so the
 * resolve-install-re-resolve flow has a single implementation; callers map
 * the result to their transport (tool error result vs. HTTP error class).
 */
export async function resolveAgentWithAutoInstall(
  agentId: string,
): Promise<ResolveWithAutoInstallResult> {
  const resolved = resolveAcpAgent(agentId);
  if (resolved.ok || resolved.reason !== "binary_not_found") {
    return { resolved };
  }

  const { command, hint } = resolved;
  const install = await ensureAdapterInstalled(command);
  if (install.installed) {
    const retried = resolveAcpAgent(agentId);
    if (retried.ok) {
      log.info(
        { agentId, command },
        "Auto-installed missing ACP adapter binary",
      );
      return {
        resolved: retried,
        autoInstalledPackage: DEFAULT_AGENT_NPM_PACKAGES[command],
      };
    }
  } else if (install.error) {
    return {
      resolved,
      failureMessage: `${command} is not on PATH. ${hint} (auto-install failed: ${install.error})`,
    };
  }
  return { resolved };
}

/** @internal: exposed for tests only. */
export function _resetAdapterInstallCacheForTests(): void {
  installPromises.clear();
}
