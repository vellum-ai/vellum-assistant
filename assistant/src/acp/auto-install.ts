/**
 * Sandboxed auto-install for known ACP adapter binaries.
 *
 * When a spawn fails preflight with `binary_not_found`, callers (the
 * `acp_spawn` tool and the `/v1/acp/spawn` route) call
 * `resolveAgentWithAutoInstall(agentId)`, which performs a ONE-TIME global
 * install of the mapped adapter package via `bun`, then re-resolves and
 * continues. After the install the adapter is a normal trusted binary on
 * PATH, and the session manager spawns it the usual way (project cwd, token
 * injected only at spawn).
 *
 * Security boundaries (this is the ATL-808 fix):
 *  - Only commands present in `DEFAULT_AGENT_NPM_PACKAGES` are ever
 *    installed. The package names are vendored constants, NOT user input.
 *  - The install runs `bun` with cwd = a FRESH empty daemon-owned temp dir,
 *    never the untrusted task project dir. A clean cwd has no project-local
 *    `node_modules/.bin`, `bunfig.toml`, or `.npmrc`, so none of the
 *    cwd-based package-resolution hijacks apply.
 *  - The installer env is a SANITIZED copy of `process.env` with known
 *    ambient secrets (`CLAUDE_CODE_OAUTH_TOKEN`, plus the `GEMINI_API_KEY`
 *    used by the Gemini LLM provider) stripped, so no secret is ever in scope
 *    during package resolution, and `BUN_CONFIG_REGISTRY` forced to the
 *    public npm registry so a redirected registry cannot serve a malicious
 *    package.
 *  - The token is injected ONLY later, at spawn time, on the real installed
 *    binary (see `prepare-agent-env.ts`). `prepareAgentEnv` is never called
 *    here.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_AGENT_NPM_PACKAGES } from "../config/acp-defaults.js";
import { getLogger } from "../util/logger.js";
import {
  resolveAcpAgent,
  type ResolveAcpAgentResult,
} from "./resolve-agent.js";

const log = getLogger("acp:auto-install");

/** Per-install timeout for the global install. Generous: cold caches are slow. */
const BUN_INSTALL_TIMEOUT_MS = 120_000;

/**
 * The trusted public npm registry. Forced via `BUN_CONFIG_REGISTRY` on the
 * installer env so a stray `.npmrc`/`bunfig.toml` in the ambient environment
 * cannot redirect package downloads to an attacker-controlled registry.
 */
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

export interface AdapterInstallResult {
  installed: boolean;
  error?: string;
}

/**
 * Per-command install promises. Concurrent spawns for the same missing
 * binary dedupe to a single global install; successful results are cached for
 * the process lifetime. Failed installs are evicted so a later spawn can
 * retry (e.g. after the user fixes network or install permissions).
 */
const installPromises = new Map<string, Promise<AdapterInstallResult>>();

/**
 * Run `execFile` with an AbortController-driven timeout. Returns the stdout
 * on success; throws on error or timeout. The optional `cwd`/`env` let the
 * installer run in a sandboxed working directory with a sanitized env.
 */
function execFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    execFile(
      command,
      args,
      {
        signal: controller.signal,
        encoding: "utf8",
        cwd: options?.cwd,
        env: options?.env,
      },
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
 * A copy of `process.env` safe to hand to the package installer: known
 * ambient secrets are stripped so they can never leak into a resolved
 * package's lifecycle/runtime, and the registry is pinned to the trusted
 * public one. `CLAUDE_CODE_OAUTH_TOKEN` is the ACP adapter token;
 * `GEMINI_API_KEY` belongs to the Gemini LLM provider but may be present in
 * the daemon env, so it is stripped here as defense-in-depth.
 */
function sanitizedInstallEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.GEMINI_API_KEY;
  env.BUN_CONFIG_REGISTRY = PUBLIC_NPM_REGISTRY;
  return env;
}

/**
 * Install the npm-registry package mapped to `command` via a sandboxed `bun`
 * global install, if (and only if) the command is a known adapter binary and
 * `bun` is on PATH. Unknown commands, or hosts without `bun`, resolve to
 * `{ installed: false }` without ever invoking a package manager (see the
 * security boundary note in the module doc).
 */
export function ensureAdapterInstalled(
  command: string,
): Promise<AdapterInstallResult> {
  const packageName = DEFAULT_AGENT_NPM_PACKAGES[command];
  if (!packageName) {
    return Promise.resolve({ installed: false });
  }

  const bunPath = Bun.which("bun");
  if (!bunPath) {
    return Promise.resolve({ installed: false });
  }

  const inFlight = installPromises.get(command);
  if (inFlight) return inFlight;

  const promise = runInstall(bunPath, command, packageName).then((result) => {
    if (!result.installed) installPromises.delete(command);
    return result;
  });
  installPromises.set(command, promise);
  return promise;
}

async function runInstall(
  bunPath: string,
  command: string,
  packageName: string,
): Promise<AdapterInstallResult> {
  log.info({ command, packageName }, "Auto-installing missing ACP adapter");
  // Fresh empty dir guaranteed to have no project-local node_modules,
  // bunfig.toml, or .npmrc - this neutralizes the cwd-based resolution
  // hijacks the untrusted task dir would otherwise enable.
  const installDir = await mkdtemp(join(tmpdir(), "vellum-acp-install-"));
  try {
    await execFileWithTimeout(
      bunPath,
      // `bun add --global` installs AND links the package bin into bun's
      // global bin dir (on PATH in every image).
      ["add", "--global", packageName],
      BUN_INSTALL_TIMEOUT_MS,
      { cwd: installDir, env: sanitizedInstallEnv() },
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
  } finally {
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ResolveWithAutoInstallResult {
  /** The final resolver outcome (post-install re-resolve when applicable). */
  resolved: ResolveAcpAgentResult;
  /** Set when a missing adapter binary was silently installed via bun. */
  autoInstalledPackage?: string;
  /**
   * Set when the auto-install itself failed: the original install hint
   * augmented with the install failure reason. Callers should surface this
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
