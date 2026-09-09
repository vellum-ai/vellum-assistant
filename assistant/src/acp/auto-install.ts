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
 * Installs name the pinned `name@version` spec from
 * `DEFAULT_AGENT_NPM_PACKAGES`, and `resolveAgentWithAutoInstall` enforces
 * that pin on every resolution, not only on the missing-binary path, so the
 * daemon always drives the adapter version it was built against. The pin is
 * enforced against the executable PATH actually selects: a bun-linked binary
 * whose global manifest disagrees with the pin is reinstalled, while one
 * installed by npm or brew is left alone with a warning, since a bun install
 * would not change which binary spawns.
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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import {
  DEFAULT_AGENT_NPM_PACKAGES,
  splitPackageSpec,
} from "../config/acp-defaults.js";
import type { AcpAgentConfig } from "../config/acp-schema.js";
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
        windowsHide: true,
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

interface AdapterVersionProbeDeps {
  readFile: (path: string) => Promise<string>;
  /**
   * Bun's global install root: `<root>/bin` holds the binaries `bun add
   * --global` links, `<root>/install/global/node_modules` the packages they
   * come from. Both halves of the pin check read this one root, so a manifest
   * is only ever compared against a binary the same install produced.
   */
  bunInstallDir: () => string;
}

const REAL_PROBE_DEPS: AdapterVersionProbeDeps = {
  readFile: (path) => readFile(path, "utf8"),
  // `bun add --global` honours BUN_INSTALL, and the installer env is a copy of
  // `process.env`, so the probe has to read the same override.
  bunInstallDir: () => process.env.BUN_INSTALL ?? join(homedir(), ".bun"),
};

let probeDeps: AdapterVersionProbeDeps = REAL_PROBE_DEPS;

/** The module tree `bun add --global` writes into. */
function globalModulesDir(): string {
  return join(probeDeps.bunInstallDir(), "install", "global", "node_modules");
}

/**
 * Whether `binaryPath` is the binary `bun add --global` links for `command`.
 * Only then does the pinned package's manifest describe the executable that a
 * spawn would actually run, and only then can a reinstall change what PATH
 * selects: an adapter installed by npm or brew keeps its place in PATH no
 * matter what bun writes.
 */
function isBunManagedBinary(command: string, binaryPath: string): boolean {
  const linked = join(probeDeps.bunInstallDir(), "bin", command);
  return resolvePath(binaryPath) === resolvePath(linked);
}

/**
 * Version of the pinned adapter package as installed in bun's global tree, or
 * undefined when the manifest is missing or unreadable. Undefined is also what
 * an adapter installed from a different package looks like (the older
 * `@zed-industries/codex-acp` owns the same `codex-acp` binary name but writes
 * nothing under the pinned package's path), which is why callers treat it as a
 * mismatch rather than as "no opinion".
 */
export async function getInstalledAdapterVersion(
  command: string,
): Promise<string | undefined> {
  const spec = DEFAULT_AGENT_NPM_PACKAGES[command];
  if (!spec) {
    return undefined;
  }
  const manifest = join(
    globalModulesDir(),
    ...splitPackageSpec(spec).name.split("/"),
    "package.json",
  );
  try {
    const parsed: unknown = JSON.parse(await probeDeps.readFile(manifest));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install the pinned npm-registry package spec mapped to `command` via a
 * sandboxed `bun` global install, if (and only if) the command is a known
 * adapter binary and `bun` is on PATH. Unknown commands, or hosts without
 * `bun`, resolve to `{ installed: false }` without ever invoking a package
 * manager (see the security boundary note in the module doc). An adapter
 * already on PATH at the pinned version resolves the same way.
 */
export function ensureAdapterInstalled(
  command: string,
  searchPath?: string,
): Promise<AdapterInstallResult> {
  const packageSpec = DEFAULT_AGENT_NPM_PACKAGES[command];
  if (!packageSpec) {
    return Promise.resolve({ installed: false });
  }

  const bunPath = Bun.which("bun");
  if (!bunPath) {
    return Promise.resolve({ installed: false });
  }

  const inFlight = installPromises.get(command);
  if (inFlight) {
    return inFlight;
  }

  const promise = installToPin(bunPath, command, packageSpec, searchPath).then(
    (result) => {
      // Only a genuine failure is evicted, so a later spawn can retry. A
      // decision NOT to install (pin already satisfied, adapter managed
      // outside bun) is cached, which is what keeps the probe to one read per
      // command per process.
      if (result.error) {
        installPromises.delete(command);
      }
      return result;
    },
  );
  installPromises.set(command, promise);
  return promise;
}

/**
 * A binary missing from PATH always installs, unchanged. One already on PATH
 * installs only when it is the binary bun linked AND its globally installed
 * version differs from the pin, which covers both an outdated install and one
 * made from a different package name that owns the same binary. An adapter
 * that came from anywhere else stays put: PATH would keep selecting it, so a
 * bun install would change nothing but the disk.
 */
async function installToPin(
  bunPath: string,
  command: string,
  packageSpec: string,
  searchPath?: string,
): Promise<AdapterInstallResult> {
  const binaryPath = whichOnPath(command, searchPath);
  if (!binaryPath) {
    return runInstall(bunPath, command, packageSpec);
  }
  const { version } = splitPackageSpec(packageSpec);
  if (version === undefined) {
    return { installed: false };
  }
  if (!isBunManagedBinary(command, binaryPath)) {
    log.warn(
      { command, binaryPath, packageSpec },
      "ACP adapter is managed outside bun; leaving it in place and skipping the version pin",
    );
    return { installed: false };
  }
  if ((await getInstalledAdapterVersion(command)) === version) {
    return { installed: false };
  }
  return runInstall(bunPath, command, packageSpec);
}

/**
 * The executable a spawn would select, resolved on the same PATH the spawn
 * will see: `AcpAgentProcess` spawns with `{ ...process.env, ...config.env }`,
 * so a per-agent `env.PATH` override wins over the assistant's PATH.
 */
function whichOnPath(command: string, searchPath?: string): string | null {
  return Bun.which(
    command,
    searchPath !== undefined ? { PATH: searchPath } : undefined,
  );
}

async function runInstall(
  bunPath: string,
  command: string,
  packageSpec: string,
): Promise<AdapterInstallResult> {
  log.info({ command, packageSpec }, "Installing pinned ACP adapter");
  // Fresh empty dir guaranteed to have no project-local node_modules,
  // bunfig.toml, or .npmrc - this neutralizes the cwd-based resolution
  // hijacks the untrusted task dir would otherwise enable.
  const installDir = await mkdtemp(join(tmpdir(), "vellum-acp-install-"));
  try {
    await execFileWithTimeout(
      bunPath,
      // `bun add --global` installs AND links the package bin into bun's
      // global bin dir (on PATH in every image).
      ["add", "--global", packageSpec],
      BUN_INSTALL_TIMEOUT_MS,
      { cwd: installDir, env: sanitizedInstallEnv() },
    );
    log.info({ command, packageSpec }, "ACP adapter auto-install succeeded");
    return { installed: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, command, packageSpec },
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
  if (resolved.ok) {
    return { resolved: await enforcePin(agentId, resolved.agent) };
  }
  if (resolved.reason !== "binary_not_found") {
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

/**
 * A resolution that succeeded still has to satisfy the pin: the adapter on
 * PATH may be an older bun-managed install, or one linked by a different
 * package that owns the same binary name. Reinstall and re-resolve when it
 * does not match. When the reinstall fails, keep the original resolution and
 * warn: a stale adapter still beats no adapter.
 */
async function enforcePin(
  agentId: string,
  agent: AcpAgentConfig,
): Promise<ResolveAcpAgentResult> {
  const { command } = agent;
  const install = await ensureAdapterInstalled(command, agent.env?.PATH);
  if (install.installed) {
    const retried = resolveAcpAgent(agentId);
    if (retried.ok) {
      log.info(
        { agentId, command },
        "Reinstalled the ACP adapter at its pinned version",
      );
      return retried;
    }
  } else if (install.error) {
    log.warn(
      { agentId, command, error: install.error },
      "Could not reinstall the ACP adapter at its pinned version; spawning the installed one",
    );
  }
  return { ok: true, agent };
}

/** @internal: exposed for tests only. */
export function _resetAdapterInstallCacheForTests(): void {
  installPromises.clear();
  probeDeps = REAL_PROBE_DEPS;
}

/** @internal: exposed for tests only. */
export function _setAdapterVersionProbeDepsForTests(
  deps: Partial<AdapterVersionProbeDeps>,
): void {
  probeDeps = { ...REAL_PROBE_DEPS, ...deps };
}
