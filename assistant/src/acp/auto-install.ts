/**
 * Sandboxed auto-install for known ACP adapter binaries.
 *
 * When a spawn fails preflight with `binary_not_found`, callers (the
 * `acp_spawn` tool and the `/v1/acp/spawn` route) call
 * `resolveAgentWithAutoInstall(agentId)`, which performs a sandboxed global
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
 * is reinstalled unless the link resolves into the pinned package and that
 * package's manifest reports the pinned version, while one installed by npm
 * or brew is left alone with a warning, since a bun install would not change
 * which binary spawns. The check runs on every resolution, never cached, so
 * an adapter replaced under a running daemon is caught on the next spawn.
 * Every install is verified by re-probing; one that reports success and still
 * leaves the pin unsatisfied abandons that pin for the life of the process,
 * so a state the probe can never satisfy costs one install, not one per
 * spawn, resume, and tool call.
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
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";

import {
  DEFAULT_AGENT_NPM_PACKAGES,
  splitPackageSpec,
} from "../config/acp-defaults.js";
import type { AcpAgentConfig } from "../config/acp-schema.js";
import { getLogger } from "../util/logger.js";
import {
  lookupAcpAgentConfig,
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
 * In-flight pin checks, keyed by command AND the search path the probe ran
 * on. Concurrent spawns for the same adapter on the same PATH dedupe to a
 * single decision, while two agents whose `env.PATH` selects different
 * binaries each get their own: one PATH reaching an externally managed
 * adapter must not exempt another PATH reaching an outdated bun-linked one.
 * Nothing is cached past settle: the adapter on disk can change under a
 * running daemon, so every spawn re-probes.
 */
const pinChecks = new Map<string, Promise<AdapterInstallResult>>();

/** In-flight global installs, keyed by command alone. */
const installRuns = new Map<string, Promise<AdapterInstallResult>>();

/** Composite map key over two fields that may contain any character. */
function joinKey(first: string, second: string): string {
  return `${first}\u0000${second}`;
}

/**
 * Share one in-flight promise per key. The entry is evicted once the promise
 * settles, whatever the outcome, so callers coalesce without anything being
 * cached across calls.
 */
function coalesce<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * Commands already reported as managed outside bun. The pin check runs per
 * spawn; the warning it can emit is worth saying once.
 */
const warnedOutsideBun = new Set<string>();

/** Commands already reported as unpinnable because `bun` is not on PATH. */
const warnedMissingBun = new Set<string>();

/**
 * `command`/`packageSpec` pairs whose install reported success and left the
 * pin unsatisfied. Nothing the daemon can do reaches the pinned state, so
 * reinstalling would block every later spawn for the install timeout with no
 * chance of succeeding. The pair is abandoned for the life of the process.
 */
const abandonedPins = new Set<string>();

/** Emit `message` once per key: the pin check runs on every resolution. */
function warnOnce(
  seen: Set<string>,
  key: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  log.warn(fields, message);
}

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
  /** Resolve a path through symlinks, as `fs.realpath` does. */
  realpath: (path: string) => Promise<string>;
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
  realpath: (path) => realpath(path),
  // `bun add --global` honours BUN_INSTALL, and the installer env is a copy of
  // `process.env`, so the probe has to read the same override.
  bunInstallDir: () => process.env.BUN_INSTALL ?? join(homedir(), ".bun"),
};

let probeDeps: AdapterVersionProbeDeps = REAL_PROBE_DEPS;

/** The module tree `bun add --global` writes into. */
function globalModulesDir(): string {
  return join(probeDeps.bunInstallDir(), "install", "global", "node_modules");
}

/** Where `bun add --global` links the bin a package exposes as `command`. */
function bunLinkPath(command: string): string {
  return join(probeDeps.bunInstallDir(), "bin", command);
}

/**
 * Whether `binaryPath` is the link `bun add --global` writes for `command`.
 * Only then can a reinstall change what PATH selects: an adapter installed by
 * npm or brew keeps its place in PATH no matter what bun writes. A lexical
 * comparison is not enough, since a PATH entry reaching bun's global bin dir
 * through a symlinked directory makes `Bun.which` report an aliased pathname
 * for the very binary bun linked, so both sides go through realpath. A
 * selected binary that cannot be resolved is left to the ownership check
 * rather than exempted; a bun link that cannot be resolved means bun linked
 * nothing here, so the selection really is external.
 */
async function isBunManagedBinary(
  command: string,
  binaryPath: string,
): Promise<boolean> {
  const linkPath = bunLinkPath(command);
  if (resolvePath(binaryPath) === resolvePath(linkPath)) {
    return true;
  }
  let selected: string;
  try {
    selected = await probeDeps.realpath(binaryPath);
  } catch {
    return true;
  }
  try {
    return selected === (await probeDeps.realpath(linkPath));
  } catch {
    return false;
  }
}

/**
 * Whether the bun link for `command` resolves to an executable inside
 * `packageName`'s directory in bun's global module tree. Bun gives one bin
 * name to whichever package linked it last, so two installed packages
 * exposing the same name (the pinned adapter and, say, the older
 * `@zed-industries/codex-acp`) both keep a manifest while only one owns the
 * link. Reading the pinned manifest alone would then report a version nothing
 * spawns. Both sides go through realpath so a symlinked bun root cancels out
 * instead of reinstalling forever. Anything that fails to resolve counts as
 * not owned, so the caller reinstalls and bun re-links the bin.
 */
async function bunLinkOwnedBy(
  command: string,
  packageName: string,
): Promise<boolean> {
  try {
    const target = await probeDeps.realpath(bunLinkPath(command));
    const owner = await probeDeps.realpath(
      join(globalModulesDir(), ...packageName.split("/")),
    );
    return target === owner || target.startsWith(owner + sep);
  } catch {
    return false;
  }
}

/**
 * Version of the pinned adapter package as installed in bun's global tree, or
 * undefined when the manifest is missing or unreadable. Undefined is also what
 * an adapter installed from a different package looks like when that package
 * writes nothing under the pinned package's path, which is why callers treat
 * it as a mismatch rather than as "no opinion". The manifest only describes
 * the executable a spawn runs once `bunLinkOwnedBy` confirms the bin link
 * still resolves into this package.
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
    warnOnce(
      warnedMissingBun,
      command,
      { command, packageSpec },
      "bun is not on PATH; leaving the ACP adapter as-is and skipping the version pin",
    );
    return Promise.resolve({ installed: false });
  }

  // Nothing survives the call: the probe is a manifest read plus a realpath,
  // cheap enough to repeat, and caching a no-install decision would pin the
  // daemon to whatever the adapter looked like at first spawn.
  return coalesce(pinChecks, joinKey(command, searchPath ?? ""), () =>
    installToPin(bunPath, command, packageSpec, searchPath),
  );
}

interface PinProbe {
  /**
   * `install`: PATH has no adapter, or the bun-linked one is not the pinned
   * package at the pinned version, which covers an outdated install and one
   * whose bin another package has taken over.
   * `external`: PATH selects an adapter bun did not link, so an install would
   * rewrite the disk without changing which binary spawns.
   * `satisfied`: the binary a spawn selects is the pin.
   */
  action: "install" | "satisfied" | "external";
  /** The executable a spawn on this search path would select. */
  binaryPath?: string;
}

/** What the pin requires of the binary `searchPath` selects right now. */
async function probePin(
  command: string,
  packageSpec: string,
  searchPath?: string,
): Promise<PinProbe> {
  const binaryPath = whichOnPath(command, searchPath);
  if (!binaryPath) {
    return { action: "install" };
  }
  const { name, version } = splitPackageSpec(packageSpec);
  if (version === undefined) {
    return { action: "satisfied", binaryPath };
  }
  if (!(await isBunManagedBinary(command, binaryPath))) {
    return { action: "external", binaryPath };
  }
  if (!(await bunLinkOwnedBy(command, name))) {
    return { action: "install", binaryPath };
  }
  const action =
    (await getInstalledAdapterVersion(command)) === version
      ? "satisfied"
      : "install";
  return { action, binaryPath };
}

/**
 * Install the pin when the probe says PATH does not already select it. The
 * install is verified by re-probing, since `bun add` exiting 0 does not prove
 * the pinned binary is what a spawn now runs: a bin link left pointing
 * elsewhere, or a realpath the daemon may not read, would otherwise reinstall
 * on every spawn forever.
 */
async function installToPin(
  bunPath: string,
  command: string,
  packageSpec: string,
  searchPath?: string,
): Promise<AdapterInstallResult> {
  const probe = await probePin(command, packageSpec, searchPath);
  if (probe.action === "external") {
    warnOnce(
      warnedOutsideBun,
      command,
      { command, binaryPath: probe.binaryPath, packageSpec },
      "ACP adapter is managed outside bun; leaving it in place and skipping the version pin",
    );
    return { installed: false };
  }
  if (probe.action === "satisfied") {
    return { installed: false };
  }
  const pinKey = joinKey(command, packageSpec);
  if (abandonedPins.has(pinKey)) {
    return { installed: false };
  }
  // Probes stay per PATH, but two PATHs spelling the same bun tree reach one
  // global tree, and racing `bun add --global` against it is the bug.
  const result = await coalesce(installRuns, command, () =>
    runInstall(bunPath, command, packageSpec),
  );
  if (!result.installed) {
    return result;
  }
  const verified = await probePin(command, packageSpec, searchPath);
  if (verified.action === "install") {
    warnOnce(
      abandonedPins,
      pinKey,
      { command, packageSpec, binaryPath: verified.binaryPath },
      "ACP adapter install reported success but PATH still does not select the pinned version; leaving it alone for the rest of this process",
    );
  }
  return result;
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
  /**
   * Set when bun installed the adapter during this resolution, whether it was
   * missing or merely off the pin, so the caller can explain the delay.
   */
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
    return enforcePin(agentId, resolved.agent);
  }
  if (resolved.reason !== "binary_not_found") {
    return { resolved };
  }

  const { command, hint } = resolved;
  // The resolver decided `binary_not_found` against the agent's own PATH, so
  // the recovery probes that PATH too: an adapter the daemon can see and the
  // agent cannot still needs installing.
  const install = await ensureAdapterInstalled(
    command,
    lookupAcpAgentConfig(agentId)?.env?.PATH,
  );
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
 * does not match, returning the re-resolution even when it failed so the
 * caller surfaces its actionable hint instead of a bare spawn ENOENT. When
 * the reinstall fails, keep the original resolution and warn: a stale adapter
 * still beats no adapter.
 */
async function enforcePin(
  agentId: string,
  agent: AcpAgentConfig,
): Promise<ResolveWithAutoInstallResult> {
  const { command } = agent;
  const install = await ensureAdapterInstalled(command, agent.env?.PATH);
  if (install.installed) {
    const retried = resolveAcpAgent(agentId);
    if (retried.ok) {
      log.info(
        { agentId, command },
        "Reinstalled the ACP adapter at its pinned version",
      );
    }
    return {
      resolved: retried,
      autoInstalledPackage: DEFAULT_AGENT_NPM_PACKAGES[command],
    };
  }
  if (install.error) {
    log.warn(
      { agentId, command, error: install.error },
      "Could not reinstall the ACP adapter at its pinned version; spawning the installed one",
    );
  }
  return { resolved: { ok: true, agent } };
}

/** @internal: exposed for tests only. */
export function _resetAdapterInstallCacheForTests(): void {
  pinChecks.clear();
  installRuns.clear();
  warnedOutsideBun.clear();
  warnedMissingBun.clear();
  abandonedPins.clear();
  probeDeps = REAL_PROBE_DEPS;
}

/** @internal: exposed for tests only. */
export function _setAdapterVersionProbeDepsForTests(
  deps: Partial<AdapterVersionProbeDeps>,
): void {
  probeDeps = { ...REAL_PROBE_DEPS, ...deps };
}
