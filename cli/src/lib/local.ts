import { execFileSync, execSync, spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { homedir, networkInterfaces, platform, tmpdir } from "os";
import { basename, dirname, join } from "path";

import { isValidReleaseVersion } from "@vellumai/local-mode";

import {
  getDaemonPidPath,
  type LocalInstanceResources,
} from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import {
  type DaemonReadiness,
  httpHealthCheck,
  probeDaemonReadiness,
  waitForDaemonMigrationsReady,
  waitForDaemonReady,
} from "./http-client.js";
import { stopIngressNginx } from "./nginx-ingress.js";
import {
  type ProcessState,
  resolveProcessState,
  stopProcess,
  stopProcessByPidFile,
} from "./process.js";
import { stripVersionPrefix } from "./version-compat.js";
import { openLogFile, pipeToLogFile } from "./xdg-log.js";

const _require = createRequire(import.meta.url);

// macOS AF_UNIX path limit (sun_path is 104 bytes, null-terminated → 103 usable).
const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;

// The longest socket filename we place in the workspace directory.
// assistant-skill.sock = 20 chars, plus 1 for the "/" separator = 21 overhead.
const LONGEST_SOCKET_FILENAME = "assistant-skill.sock";
const LOCAL_RUNTIME_PACKAGE = "vellum";

export interface LocalRuntimeInstall {
  version: string;
  installDir: string;
}

function normalizeRuntimeVersion(version: string): string {
  return version === "latest" ? version : stripVersionPrefix(version);
}

export function getLocalRuntimeInstallDir(
  resources: LocalInstanceResources,
  version: string,
): string {
  return join(
    resources.instanceDir,
    ".vellum",
    "runtime",
    normalizeRuntimeVersion(version),
  );
}

function packagePath(
  installDir: string,
  packageName: string,
  relativePath: string,
): string {
  return join(
    installDir,
    "node_modules",
    ...packageName.split("/"),
    relativePath,
  );
}

function hasLocalRuntimeComponents(installDir: string): boolean {
  return (
    existsSync(
      packagePath(installDir, "@vellumai/assistant", "src/index.ts"),
    ) &&
    existsSync(
      packagePath(installDir, "@vellumai/vellum-gateway", "src/index.ts"),
    ) &&
    existsSync(
      packagePath(installDir, "@vellumai/credential-executor", "src/main.ts"),
    )
  );
}

function resolveBunExecutable(): string {
  const execBase = basename(process.execPath);
  if (execBase === "bun" || execBase.startsWith("bun-")) {
    return process.execPath;
  }

  const envBun = process.env.VELLUM_BUN;
  if (envBun && existsSync(envBun)) return envBun;

  const siblingBun = join(dirname(process.execPath), "bun");
  if (existsSync(siblingBun)) return siblingBun;

  const bundledBun = join(dirname(process.execPath), "..", "Resources", "bun");
  if (existsSync(bundledBun)) return bundledBun;

  const homeBun = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(homeBun)) return homeBun;

  return "bun";
}

function envWithBunPath(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const bunPath = resolveBunExecutable();
  const basePath = env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const extraDirs = [
    bunPath.includes("/") ? dirname(bunPath) : "",
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ].filter((dir) => dir && !basePath.split(":").includes(dir));
  return {
    ...env,
    PATH: [...extraDirs, basePath].filter(Boolean).join(":"),
  };
}

function localRuntimeAssistantIndex(
  resources: LocalInstanceResources,
): string | undefined {
  const installDir = resources.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(
    installDir,
    "@vellumai/assistant",
    "src/index.ts",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function localRuntimeGatewayDir(
  resources: LocalInstanceResources | undefined,
): string | undefined {
  const installDir = resources?.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(installDir, "@vellumai/vellum-gateway", "");
  return isGatewaySourceDir(candidate) ? candidate : undefined;
}

function localRuntimeCesDir(
  resources: LocalInstanceResources | undefined,
): string | undefined {
  const installDir = resources?.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(
    installDir,
    "@vellumai/credential-executor",
    "",
  );
  return isCesSourceDir(candidate) ? candidate : undefined;
}

export function ensureLocalRuntime(
  resources: LocalInstanceResources,
  version: string,
  options: { force?: boolean } = {},
): LocalRuntimeInstall {
  // Reject anything that is not a trusted release identifier BEFORE it becomes
  // a filesystem path segment or a `bun install` dependency spec. Without this,
  // a package-manager spec (npm alias, tarball/git URL) or a `../`-laden string
  // reaching this sink would install and then execute arbitrary attacker code
  // as the local assistant runtime. Shares the validator with the host-bridge
  // boundary guard (`runUpgrade`) so the two can never drift.
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `Invalid runtime version '${version}': expected a release tag like v1.2.3 or 'latest'.`,
    );
  }

  const normalizedVersion = normalizeRuntimeVersion(version);
  const displayVersion =
    normalizedVersion === "latest" ? "latest" : `v${normalizedVersion}`;
  const installDir = getLocalRuntimeInstallDir(resources, normalizedVersion);

  if (!options.force && hasLocalRuntimeComponents(installDir)) {
    return { version: displayVersion, installDir };
  }

  ensureBunInstalled();
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          [LOCAL_RUNTIME_PACKAGE]: normalizedVersion,
        },
      },
      null,
      2,
    )}\n`,
  );

  const bunPath = resolveBunExecutable();
  const result = spawnSync(bunPath, ["install", "--ignore-scripts"], {
    cwd: installDir,
    stdio: "inherit",
    env: envWithBunPath(process.env),
  });

  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? `bun install exited with code ${result.status}`;
    throw new Error(`Local runtime install failed: ${detail}`);
  }

  if (!hasLocalRuntimeComponents(installDir)) {
    throw new Error(
      `Local runtime install at ${installDir} is missing assistant, gateway, or credential-executor packages.`,
    );
  }

  return { version: displayVersion, installDir };
}

/**
 * Warn when an assistant appears to have legacy data in the global workspace.
 *
 * Old local startup paths could launch the daemon without
 * `VELLUM_WORKSPACE_DIR`, causing writes to fall back to `~/.vellum/workspace`.
 * New local instance launches pin the workspace under
 * `<instanceDir>/.vellum/workspace`. If we detect data only in the legacy
 * global path, warn with migration instructions so users are not surprised by
 * missing history/settings after the fix.
 */
function warnIfLegacyWorkspaceFallbackDetected(
  resources: LocalInstanceResources,
): void {
  const instanceWorkspace = join(resources.instanceDir, ".vellum", "workspace");
  const instanceDbPath = join(instanceWorkspace, "data", "db", "assistant.db");

  const legacyWorkspace = join(homedir(), ".vellum", "workspace");
  const legacyDbPath = join(legacyWorkspace, "data", "db", "assistant.db");

  // Legacy "first local" entries use ~/.vellum directly; no drift possible.
  if (instanceWorkspace === legacyWorkspace) return;

  if (existsSync(legacyDbPath) && !existsSync(instanceDbPath)) {
    console.warn("");
    console.warn(
      "WARNING: Detected legacy workspace data in ~/.vellum/workspace for this local assistant.",
    );
    console.warn("   What this means:");
    console.warn(
      "   - An older startup path likely wrote assistant data to the global workspace.",
    );
    console.warn(
      "   - This assistant now uses its instance workspace instead:",
    );
    console.warn(`     ${instanceWorkspace}`);
    console.warn("   What to do:");
    console.warn(
      "   1. Stop the assistant before migrating files (retire/sleep or quit app).",
    );
    console.warn(
      "   2. Copy needed data from ~/.vellum/workspace into the instance workspace.",
    );
    console.warn(
      `      Example: cp -a ~/.vellum/workspace/data/db/assistant.db* ${join(instanceWorkspace, "data", "db")}/`,
    );
    console.warn(
      "   3. Re-launch and confirm history/settings appear as expected.",
    );
    console.warn("");
  }
}

/**
 * On macOS, if `{workspaceDir}/assistant-skill.sock` would exceed the
 * 103-byte AF_UNIX path limit, compute a short tmpdir-based IPC socket
 * directory and return it.  Returns `undefined` when no override is needed
 * (the workspace path is short enough, or we're not on macOS).
 */
function computeIpcSocketDirOverride(workspaceDir: string): string | undefined {
  if (platform() !== "darwin") return undefined;

  const longestPath = join(workspaceDir, LONGEST_SOCKET_FILENAME);
  if (
    Buffer.byteLength(longestPath, "utf8") <= DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
  ) {
    return undefined;
  }

  // Use a short hash of the workspace dir so multiple instances get
  // distinct socket directories under /tmp.
  const hash = createHash("sha256")
    .update(workspaceDir)
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `vellum-ipc-${hash}`);
}

/**
 * If the workspace path is too long for AF_UNIX sockets on macOS, compute
 * a short override directory and set all IPC socket env vars on the target
 * env object. No-op on non-macOS or when paths are within limits.
 */
function applyIpcSocketDirOverride(
  env: Record<string, string | undefined>,
): void {
  const workspaceDir =
    env.VELLUM_WORKSPACE_DIR || join(homedir(), ".vellum", "workspace");
  const override = computeIpcSocketDirOverride(workspaceDir);
  if (!override) return;

  mkdirSync(override, { recursive: true });
  env.GATEWAY_IPC_SOCKET_DIR = override;
  env.ASSISTANT_IPC_SOCKET_DIR = override;
  env.ASSISTANT_SKILL_IPC_SOCKET_DIR = override;
}

function isAssistantSourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "index.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@vellumai/assistant";
  } catch {
    return false;
  }
}

function findAssistantSourceFrom(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (isAssistantSourceDir(current)) {
      return current;
    }
    const nestedCandidate = join(current, "assistant");
    if (isAssistantSourceDir(nestedCandidate)) {
      return nestedCandidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isGatewaySourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "index.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@vellumai/vellum-gateway";
  } catch {
    return false;
  }
}

function isCesSourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "main.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@vellumai/credential-executor";
  } catch {
    return false;
  }
}

function findGatewaySourceFromCwd(): string | undefined {
  let current = process.cwd();
  while (true) {
    if (isGatewaySourceDir(current)) {
      return current;
    }
    const nestedCandidate = join(current, "gateway");
    if (isGatewaySourceDir(nestedCandidate)) {
      return nestedCandidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveAssistantIndexPath(
  resources?: LocalInstanceResources,
): string | undefined {
  if (resources) {
    const runtimeIndex = localRuntimeAssistantIndex(resources);
    if (runtimeIndex) return runtimeIndex;
  }

  // Source tree layout: cli/src/lib/ -> ../../.. -> repo root -> assistant/src/index.ts
  const sourceTreeIndex = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "assistant",
    "src",
    "index.ts",
  );
  if (existsSync(sourceTreeIndex)) {
    return sourceTreeIndex;
  }

  // bunx layout: @vellumai/cli/src/lib/ -> ../../../.. -> node_modules/vellum/src/index.ts
  const bunxIndex = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "vellum",
    "src",
    "index.ts",
  );
  if (existsSync(bunxIndex)) {
    return bunxIndex;
  }

  const cwdSourceDir = findAssistantSourceFrom(process.cwd());
  if (cwdSourceDir) {
    return join(cwdSourceDir, "src", "index.ts");
  }

  const execSourceDir = findAssistantSourceFrom(dirname(process.execPath));
  if (execSourceDir) {
    return join(execSourceDir, "src", "index.ts");
  }

  try {
    const assistantPkgPath = _require.resolve(
      "@vellumai/assistant/package.json",
    );
    const resolved = join(dirname(assistantPkgPath), "src", "index.ts");
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // resolution failed
  }

  return undefined;
}

function ensureBunInstalled(): void {
  try {
    execFileSync(resolveBunExecutable(), ["--version"], {
      stdio: "pipe",
      env: envWithBunPath(process.env),
    });
    return;
  } catch {
    // bun not found, try to install
  }

  console.log("   Installing bun...");
  try {
    const installEnv: Record<string, string> = {
      HOME: process.env.HOME || homedir(),
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR || "/tmp",
      USER: process.env.USER || "",
      LANG: process.env.LANG || "",
    };
    // Preserve proxy/TLS env vars so curl works in proxied/corporate environments
    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "CURL_CA_BUNDLE",
    ]) {
      if (process.env[key]) {
        installEnv[key] = process.env[key]!;
      }
    }
    execSync("curl -fsSL https://bun.sh/install | bash", {
      stdio: "pipe",
      timeout: 60_000,
      env: installEnv,
    });
    console.log("   Bun installed successfully");
  } catch {
    console.log(
      "   ⚠️  Failed to install bun — some features may be unavailable",
    );
  }
}

function resolveDaemonMainPath(assistantIndex: string): string {
  return join(dirname(assistantIndex), "daemon", "main.ts");
}

/**
 * Generate a fresh signing key for a local hatch session.
 *
 * Both the daemon and gateway must use the same HMAC signing key so JWT
 * tokens minted by one can be verified by the other. The CLI generates
 * an ephemeral key each time and passes it as `ACTOR_TOKEN_SIGNING_KEY`
 * to both processes — the daemon and gateway each persist it on their
 * own terms (the `.vellum/` directory layout is their concern, not the
 * CLI's).
 */
export function generateLocalSigningKey(): string {
  return randomBytes(32).toString("hex");
}

type DaemonStartOptions = {
  foreground?: boolean;
  defaultWorkspaceConfigPath?: string;
  signingKey?: string;
};

/**
 * Apply per-instance resource overrides and shared daemon options to an
 * environment object. Called from all daemon spawn paths (source, watch,
 * bundled binary) to eliminate drift between the three.
 */
function applyDaemonEnvOverrides(
  env: Record<string, string | undefined>,
  resources: LocalInstanceResources | undefined,
  options?: DaemonStartOptions,
): void {
  if (resources) {
    env.VELLUM_WORKSPACE_DIR = join(
      resources.instanceDir,
      ".vellum",
      "workspace",
    );
    env.GATEWAY_SECURITY_DIR = join(
      resources.instanceDir,
      ".vellum",
      "protected",
    );
    env.CREDENTIAL_SECURITY_DIR = join(
      resources.instanceDir,
      ".vellum",
      "protected",
    );
    env.RUNTIME_HTTP_PORT = String(resources.daemonPort);
    env.GATEWAY_PORT = String(resources.gatewayPort);
    env.QDRANT_HTTP_PORT = String(resources.qdrantPort);
    delete env.QDRANT_URL;
  }
  if (options?.signingKey) {
    env.ACTOR_TOKEN_SIGNING_KEY = options.signingKey;
  }
  if (options?.defaultWorkspaceConfigPath) {
    env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
      options.defaultWorkspaceConfigPath;
  }
  // When the CLI launches CES as a sibling (CES_STANDALONE), pin the daemon to
  // the exact socket the sibling binds so the two agree regardless of any stale
  // CES_LOCAL_SOCKET inherited from the parent environment. The assistant then
  // connects to the sibling instead of spawning its own CES.
  if (isCesSiblingOptIn()) {
    env.CES_STANDALONE = "1";
    env.CES_LOCAL_SOCKET = resolveCesSocketPath(resources);
  }
  applyIpcSocketDirOverride(env);
}

function logDaemonReadiness(readiness: DaemonReadiness): void {
  switch (readiness) {
    case "ready":
      console.log("   Assistant ready\n");
      break;
    case "migrating":
      console.log(
        "   Assistant is up — database migrations still running; DB-backed commands return 503 until they finish\n",
      );
      break;
    case "failed":
      console.log(
        "   ⚠️  Assistant database migrations FAILED — DB-backed commands return 503 until the assistant is restarted\n",
      );
      break;
    default:
      console.log(
        "   ⚠️  Assistant did not become ready within 60s — continuing anyway\n",
      );
  }
}

function logAssistantAlreadyRunning(
  pid: number,
  status: ProcessState["status"],
): void {
  const suffix =
    status === "migration_failed"
      ? " but its database migrations failed — restart to recover"
      : status === "unready"
        ? " — database migrations still running"
        : "";
  console.log(`   Assistant already running (pid ${pid})${suffix}\n`);
}

async function startDaemonFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<boolean> {
  const foreground = options?.foreground ?? false;
  const daemonMainPath = resolveDaemonMainPath(assistantIndex);

  // Ensure the directory containing PID/socket files exists. For named
  // instances this is instanceDir/.vellum/workspace/ (matching daemon's getWorkspaceDir()).
  const pidFile = getDaemonPidPath(resources);
  mkdirSync(dirname(pidFile), { recursive: true });

  // --- Lifecycle guard: prevent split-brain daemon state ---
  if (await awaitStartingSentinel(pidFile, resources.daemonPort)) return false;

  const daemonState = await resolveProcessState(
    pidFile,
    resources.daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    return false;
  }

  if (await checkOrphanedDaemon(pidFile, resources.daemonPort)) return false;

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    VELLUM_CLOUD: "local",
    VELLUM_DEV: "1",
    VELLUM_ENVIRONMENT: process.env.VELLUM_ENVIRONMENT || "local",
  };
  applyDaemonEnvOverrides(env, resources, options);

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const bunPath = resolveBunExecutable();
  const spawnEnv = envWithBunPath(env);
  const child = foreground
    ? spawn(bunPath, ["run", daemonMainPath], {
        stdio: "inherit",
        env: spawnEnv,
      })
    : (() => {
        const daemonLogFd = openLogFile("hatch.log");
        const c = spawn(bunPath, ["run", daemonMainPath], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: spawnEnv,
        });
        pipeToLogFile(c, daemonLogFd, "daemon");
        c.unref();
        return c;
      })();

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid), "utf-8");
  } else {
    try {
      unlinkSync(pidFile);
    } catch {}
  }
  return true;
}

// NOTE: startDaemonWatchFromSource() is the CLI-side watch-mode daemon
// launcher. Its lifecycle guards should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
async function startDaemonWatchFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<boolean> {
  const mainPath = resolveDaemonMainPath(assistantIndex);
  if (!existsSync(mainPath)) {
    throw new Error(`Daemon main.ts not found at ${mainPath}`);
  }

  const pidFile = getDaemonPidPath(resources);
  mkdirSync(dirname(pidFile), { recursive: true });

  // --- Lifecycle guard: prevent split-brain daemon state ---
  if (await awaitStartingSentinel(pidFile, resources.daemonPort)) return false;

  const daemonState = await resolveProcessState(
    pidFile,
    resources.daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    return false;
  }

  if (await checkOrphanedDaemon(pidFile, resources.daemonPort)) return false;

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    VELLUM_DEV: "1",
    VELLUM_ENVIRONMENT: process.env.VELLUM_ENVIRONMENT || "local",
  };
  applyDaemonEnvOverrides(env, resources, options);

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const daemonLogFd = openLogFile("hatch.log");
  const child = spawn(resolveBunExecutable(), ["--watch", "run", mainPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: envWithBunPath(env),
  });
  pipeToLogFile(child, daemonLogFd, "daemon");
  child.unref();
  const daemonPid = child.pid;

  // Overwrite sentinel with real PID, or clean up on spawn failure.
  if (daemonPid) {
    writeFileSync(pidFile, String(daemonPid), "utf-8");
  } else {
    try {
      unlinkSync(pidFile);
    } catch {}
  }

  console.log("   Assistant started in watch mode (bun --watch)");
  return true;
}

function resolveGatewayDir(resources?: LocalInstanceResources): string {
  const runtimeGatewayDir = localRuntimeGatewayDir(resources);
  if (runtimeGatewayDir) return runtimeGatewayDir;

  // Source tree: cli/src/lib/ → ../../.. → repo root → gateway/
  const sourceDir = join(import.meta.dir, "..", "..", "..", "gateway");
  if (isGatewaySourceDir(sourceDir)) {
    return sourceDir;
  }

  // npm-installed: @vellumai/cli and @vellumai/vellum-gateway are siblings
  const npmGatewayDir = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "vellum-gateway",
  );
  if (isGatewaySourceDir(npmGatewayDir)) {
    return npmGatewayDir;
  }

  // Compiled binary: gateway/ bundled adjacent to the CLI executable.
  const binGateway = join(dirname(process.execPath), "gateway");
  if (isGatewaySourceDir(binGateway)) {
    return binGateway;
  }

  const cwdSourceDir = findGatewaySourceFromCwd();
  if (cwdSourceDir) {
    return cwdSourceDir;
  }

  try {
    const pkgPath = _require.resolve("@vellumai/vellum-gateway/package.json");
    return dirname(pkgPath);
  } catch {
    throw new Error(
      "Gateway not found. Ensure @vellumai/vellum-gateway is installed or run from the source tree.",
    );
  }
}

function resolveCesDir(resources?: LocalInstanceResources): string {
  const runtimeCesDir = localRuntimeCesDir(resources);
  if (runtimeCesDir) return runtimeCesDir;

  // Source tree / npm sibling: cli/src/lib/ → ../../.. → credential-executor/
  const sourceDir = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "credential-executor",
  );
  if (isCesSourceDir(sourceDir)) {
    return sourceDir;
  }

  // npm-installed elsewhere on disk: resolve via the package entry.
  try {
    const pkgPath = _require.resolve(
      "@vellumai/credential-executor/package.json",
    );
    return dirname(pkgPath);
  } catch {
    throw new Error(
      "credential-executor not found. Ensure @vellumai/credential-executor is installed or run from the source tree.",
    );
  }
}

/**
 * Resolve the Unix socket path the CLI-launched CES sibling binds and the
 * daemon connects to. Both sides read `CES_LOCAL_SOCKET`, which the CLI sets to
 * this exact path so they agree. On macOS, long workspace paths are relocated
 * to a short tmpdir override (the same one the IPC sockets use) to stay under
 * the AF_UNIX path limit.
 */
function resolveCesSocketPath(resources?: LocalInstanceResources): string {
  const workspaceDir = resources
    ? join(resources.instanceDir, ".vellum", "workspace")
    : join(homedir(), ".vellum", "workspace");
  const override = computeIpcSocketDirOverride(workspaceDir);
  const socketDir = override ?? workspaceDir;
  mkdirSync(socketDir, { recursive: true });
  return join(socketDir, "ces.sock");
}

/**
 * Whether the CLI should launch CES as an independent sibling process instead
 * of leaving the assistant to spawn it as an stdio child. Temporary opt-in
 * (`CES_STANDALONE=1`) while local CES converges onto the sibling model that
 * containerized homes already use.
 */
function isCesSiblingOptIn(): boolean {
  return process.env.CES_STANDALONE === "1";
}

/**
 * Launch the local CES sibling over a Unix socket (opted into via
 * `CES_STANDALONE=1`). No-op unless the opt-in is set, in which case the
 * assistant continues to spawn CES itself as today.
 *
 * The sibling runs with `CES_STANDALONE=1` so its lifecycle is anchored to
 * SIGTERM rather than stdin EOF, mirroring the gateway: a CLI-owned process
 * with a PID file under `.vellum/ces.pid`, started by `wake` and stopped by
 * `sleep`.
 */
export async function startCes(
  watch: boolean = false,
  resources?: LocalInstanceResources,
): Promise<void> {
  if (!isCesSiblingOptIn()) return;

  const vellumDir = resources
    ? join(resources.instanceDir, ".vellum")
    : join(homedir(), ".vellum");
  const cesPidFile = join(vellumDir, "ces.pid");

  // Kill any existing sibling first — a stale CES holds the socket and would
  // corrupt the shared credential store if a second copy also bound it.
  await stopProcessByPidFile(cesPidFile, "credential-executor");

  console.log("🔐 Starting credential-executor sibling...");

  const socketPath = resolveCesSocketPath(resources);
  // A stale socket file from an unclean shutdown blocks re-bind; CES unlinks it
  // on startup, but remove it here too so a leftover never masks a launch bug.
  try {
    unlinkSync(socketPath);
  } catch {
    /* no stale socket — fine */
  }

  const securityDir = resources
    ? join(resources.instanceDir, ".vellum", "protected")
    : join(homedir(), ".vellum", "protected");
  const workspaceDir = resources
    ? join(resources.instanceDir, ".vellum", "workspace")
    : join(homedir(), ".vellum", "workspace");
  mkdirSync(securityDir, { recursive: true });

  const cesEnv: Record<string, string | undefined> = {
    ...process.env,
    CES_STANDALONE: "1",
    CES_LOCAL_SOCKET: socketPath,
    CREDENTIAL_SECURITY_DIR: securityDir,
    VELLUM_WORKSPACE_DIR: workspaceDir,
  };

  let ces;
  const runtimeCesDir = !watch ? localRuntimeCesDir(resources) : undefined;
  const cesBinary = join(dirname(process.execPath), "credential-executor");
  if (!runtimeCesDir && existsSync(cesBinary) && !watch) {
    // Compiled binary alongside the CLI (desktop app / compiled CLI).
    const cesLogFd = openLogFile("hatch.log");
    ces = spawn(cesBinary, [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: cesEnv,
    });
    pipeToLogFile(ces, cesLogFd, "credential-executor");
  } else {
    // Source tree / bunx: run the CES entry point via bun.
    const cesDir = runtimeCesDir ?? resolveCesDir(resources);
    const bunArgs = watch
      ? ["--watch", "run", "src/main.ts"]
      : ["run", "src/main.ts"];
    const cesLogFd = openLogFile("hatch.log");
    ces = spawn(resolveBunExecutable(), bunArgs, {
      cwd: cesDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithBunPath(cesEnv),
    });
    pipeToLogFile(ces, cesLogFd, "credential-executor");
    if (watch) {
      console.log("   credential-executor started in watch mode (bun --watch)");
    }
  }

  ces.unref();

  if (ces.pid) {
    mkdirSync(vellumDir, { recursive: true });
    writeFileSync(cesPidFile, String(ces.pid), "utf-8");
  }

  // Wait for the socket to appear so the daemon's discovery finds it on the
  // first probe rather than burning its retry budget.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(socketPath)) {
    console.warn(
      "⚠ credential-executor started but its socket did not appear within 10s",
    );
  } else {
    console.log("✅ credential-executor started\n");
  }
}

/**
 * Check if the daemon is responsive by hitting its HTTP `/healthz` endpoint.
 * This replaces the socket-based `isSocketResponsive()` check.
 */
async function isDaemonResponsive(daemonPort: number): Promise<boolean> {
  return httpHealthCheck(daemonPort);
}

/**
 * Find the PID of the process listening on the given TCP port.
 * Uses `lsof` on macOS/Linux. Returns undefined if no listener is found
 * or the command fails.
 */
function findPidListeningOnPort(port: number): number | undefined {
  try {
    const output = execFileSync(
      "lsof",
      ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // lsof -t may return multiple PIDs (one per line); take the first.
    const pid = parseInt(output.split("\n")[0], 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Recover PID tracking for a daemon that is already responsive on its HTTP
 * port but whose PID file is stale or missing. Looks up the listener PID
 * via `lsof` and writes it to `pidFile` so lifecycle commands (sleep, retire,
 * wake) can target the running process.
 *
 * Returns the recovered PID, or undefined if recovery failed.
 */
function recoverPidFile(
  pidFile: string,
  daemonPort: number,
): number | undefined {
  const pid = findPidListeningOnPort(daemonPort);
  if (pid) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(pid), "utf-8");
  }
  return pid;
}

/**
 * Handle the "starting" sentinel in a PID file. When another caller is
 * already spawning the daemon, wait for it to become ready instead of
 * racing to spawn a duplicate.
 *
 * Returns `true` if the daemon became ready (caller should return early),
 * `false` if the spawn failed or the sentinel wasn't present (caller
 * should proceed). Cleans up the PID file on failure.
 */
async function awaitStartingSentinel(
  pidFile: string,
  daemonPort: number,
): Promise<boolean> {
  if (!existsSync(pidFile)) return false;
  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    if (content !== "starting") return false;
  } catch {
    return false;
  }

  console.log("   Assistant is starting — waiting for it to become ready...");
  const readiness = await waitForDaemonMigrationsReady(
    daemonPort,
    Date.now() + 60000,
  );
  if (readiness !== "unreachable") {
    // The daemon exists and is answering — migrating and failed states must
    // NOT fall through to a second spawn (split-brain). Report honestly.
    logDaemonReadiness(readiness);
    return true;
  }
  try {
    unlinkSync(pidFile);
  } catch {}
  return false;
}

/**
 * Check if a daemon without a valid PID file is still reachable on its
 * HTTP port (orphaned process). If so, recover its PID file so lifecycle
 * commands can manage it.
 *
 * Returns `true` if an orphaned daemon was found (caller should skip
 * starting a new one), `false` otherwise.
 */
async function checkOrphanedDaemon(
  pidFile: string,
  daemonPort: number,
): Promise<boolean> {
  if (!(await isDaemonResponsive(daemonPort))) return false;

  const recoveredPid = recoverPidFile(pidFile, daemonPort);
  if (recoveredPid) {
    console.log(
      `   Assistant is responsive (pid ${recoveredPid}) — skipping restart\n`,
    );
  } else {
    console.log("   Assistant is responsive — skipping restart\n");
  }
  return true;
}

export async function discoverPublicUrl(
  port?: number,
): Promise<string | undefined> {
  const effectivePort = port ?? GATEWAY_PORT;

  // Start cloud metadata lookup (may take up to 1s on non-cloud hosts).
  const cloudIpPromise = discoverCloudExternalIp();

  // Resolve local address synchronously (no I/O) — does not log.
  const localResult = discoverLocalUrl(effectivePort);

  // Race: if cloud IP resolves quickly, prefer it; otherwise return the
  // local URL immediately instead of blocking on the full metadata timeout.
  const cloudIp = await Promise.race([
    cloudIpPromise,
    // Give cloud metadata a short grace period (150ms) before falling back
    // to the local address. This is enough for on-cloud hosts where the
    // metadata endpoint responds in single-digit ms, but avoids the full
    // 1s timeout on non-cloud machines.
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 150),
    ),
  ]);

  if (cloudIp) {
    console.log(`   Discovered external IP: ${cloudIp}`);
    return `http://${cloudIp}:${effectivePort}`;
  }

  return localResult.url;
}

/**
 * Returns the localhost URL for the gateway on the given port.
 */
function discoverLocalUrl(effectivePort: number): {
  url: string;
  source: "localhost";
} {
  return {
    url: `http://127.0.0.1:${effectivePort}`,
    source: "localhost",
  };
}

/**
 * Attempt to discover the VM's external/public IP via cloud metadata services.
 * Tries GCP and AWS IMDSv2 in parallel with a short timeout. Returns undefined
 * on non-cloud machines (the metadata endpoint is unreachable).
 */
async function discoverCloudExternalIp(): Promise<string | undefined> {
  const timeoutMs = 1000;

  const gcpPromise = (async (): Promise<string | undefined> => {
    try {
      const resp = await fetch(
        "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (resp.ok) return (await resp.text()).trim() || undefined;
    } catch {
      // metadata service not reachable
    }
    return undefined;
  })();

  const awsPromise = (async (): Promise<string | undefined> => {
    try {
      const tokenResp = await fetch("http://169.254.169.254/latest/api/token", {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "30" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (tokenResp.ok) {
        const token = await tokenResp.text();
        const ipResp = await fetch(
          "http://169.254.169.254/latest/meta-data/public-ipv4",
          {
            headers: { "X-aws-ec2-metadata-token": token },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (ipResp.ok) return (await ipResp.text()).trim() || undefined;
      }
    } catch {
      // metadata service not reachable
    }
    return undefined;
  })();

  const [gcpIp, awsIp] = await Promise.all([gcpPromise, awsPromise]);
  return gcpIp ?? awsIp;
}

/**
 * Returns the local IPv4 address most likely to be reachable from other
 * devices on the same LAN.
 *
 * Priority order:
 *   1. en0 (Wi-Fi on macOS)
 *   2. en1 (secondary network on macOS)
 *   3. First non-loopback IPv4 on any interface
 *
 * Skips link-local addresses (169.254.x.x) and IPv6.
 * Returns undefined if no suitable address is found.
 */
export function getLocalLanIPv4(): string | undefined {
  const ifaces = networkInterfaces();

  // Priority interfaces in order
  const priorityInterfaces = ["en0", "en1"];

  for (const ifName of priorityInterfaces) {
    const addrs = ifaces[ifName];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        !addr.address.startsWith("169.254.")
      ) {
        return addr.address;
      }
    }
  }

  // Fallback: first non-loopback, non-link-local IPv4 on any interface
  for (const [, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        !addr.address.startsWith("169.254.")
      ) {
        return addr.address;
      }
    }
  }

  return undefined;
}

/**
 * Check whether watch-mode startup is possible for the assistant daemon.
 * Watch mode requires source files (bun --watch only works with .ts sources,
 * not compiled binaries). Returns true when assistant source can be resolved,
 * false otherwise.
 *
 * Use this before stopping a running assistant for a watch-mode restart — if
 * watch mode isn't available (e.g. packaged desktop app without source), the
 * caller should keep the existing process alive rather than killing it and
 * failing.
 */
export function isAssistantWatchModeAvailable(): boolean {
  return resolveAssistantIndexPath() !== undefined;
}

/**
 * Check whether watch-mode startup is possible for the gateway. Watch mode
 * requires gateway source files (bun --watch only works with .ts sources).
 * Returns true when the gateway source directory can be resolved, false
 * otherwise.
 *
 * Use this before stopping a running gateway for a watch-mode restart — if
 * watch mode isn't available, the caller should keep the existing process
 * alive rather than killing it and failing.
 */
export function isGatewayWatchModeAvailable(): boolean {
  try {
    const dir = resolveGatewayDir();
    return existsSync(join(dir, "src", "index.ts"));
  } catch {
    return false;
  }
}

/**
 * Write (or overwrite) a shell wrapper at `<workspace>/bin/assistant` that
 * pre-injects the three instance-specific env vars before exec-ing the real
 * assistant binary from the app bundle.
 *
 * This lets developers invoke `<workspace>/bin/assistant <command>` directly
 * from the terminal without manually setting env vars.  Only created when a
 * compiled `assistant` binary is present adjacent to the CLI executable (i.e.
 * inside a desktop app bundle) — a no-op in source/watch mode.
 *
 * The wrapper is idempotent: safe to call on every daemon wake.
 */
function writeAssistantWrapper(resources: LocalInstanceResources): void {
  const assistantBinary = join(dirname(process.execPath), "assistant");
  if (!existsSync(assistantBinary)) return;

  const workspaceDir = join(resources.instanceDir, ".vellum", "workspace");
  const protectedDir = join(resources.instanceDir, ".vellum", "protected");
  const binDir = join(workspaceDir, "bin");

  mkdirSync(binDir, { recursive: true });
  const wrapperPath = join(binDir, "assistant");
  writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      `export VELLUM_WORKSPACE_DIR="${workspaceDir}"`,
      `export CREDENTIAL_SECURITY_DIR="${protectedDir}"`,
      `export GATEWAY_SECURITY_DIR="${protectedDir}"`,
      `exec "${assistantBinary}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

// NOTE: startLocalDaemon() is the CLI-side daemon lifecycle manager.
// It should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
export async function startLocalDaemon(
  watch: boolean = false,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<void> {
  warnIfLegacyWorkspaceFallbackDetected(resources);
  writeAssistantWrapper(resources);

  const runtimeAssistantIndex = !watch
    ? localRuntimeAssistantIndex(resources)
    : undefined;
  if (runtimeAssistantIndex) {
    console.log("🔨 Starting local assistant runtime...");
    // Wait for readiness only after an actual spawn — an attach to an
    // already-running daemon was classified and logged inside
    // startDaemonFromSource, and re-waiting would just block on a migration
    // the user was already told about.
    if (
      await startDaemonFromSource(runtimeAssistantIndex, resources, options)
    ) {
      logDaemonReadiness(
        await waitForDaemonMigrationsReady(
          resources.daemonPort,
          Date.now() + 60000,
        ),
      );
    }
    return;
  }

  const foreground = options?.foreground ?? false;
  // Check for a compiled daemon binary adjacent to the CLI executable.
  // This covers both the desktop app (VELLUM_DESKTOP_APP) and the case where
  // the user runs the compiled CLI directly from the terminal (e.g. via a
  // /usr/local/bin/vellum symlink into the app bundle).
  const daemonBinary = join(dirname(process.execPath), "vellum-daemon");
  if (existsSync(daemonBinary) && !watch) {
    // In watch mode, skip the bundled binary and use source (bun --watch
    // only works with source files, not compiled binaries).

    const pidFile = getDaemonPidPath(resources);

    // --- Lifecycle guard: prevent split-brain daemon state ---
    if (await awaitStartingSentinel(pidFile, resources.daemonPort)) {
      ensureBunInstalled();
      return;
    }

    const daemonState = await resolveProcessState(
      pidFile,
      resources.daemonPort,
      "Assistant",
      60_000,
      "readyz",
    );
    const daemonAlive = daemonState.status !== "needs_start";
    if (daemonAlive) {
      logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    }

    if (!daemonAlive) {
      if (await checkOrphanedDaemon(pidFile, resources.daemonPort)) {
        ensureBunInstalled();
        // The orphan already answers health checks — a single readiness probe
        // classifies it without blocking on an in-flight migration.
        logDaemonReadiness(await probeDaemonReadiness(resources.daemonPort));
        return;
      }

      console.log("🔨 Starting assistant...");

      // Ensure bun is available for runtime features (browser, skills install)
      ensureBunInstalled();

      // Ensure the directory containing PID files exists
      mkdirSync(dirname(pidFile), { recursive: true });

      // Build a minimal environment for the daemon. When launched from the
      // macOS app the CLI inherits a huge environment (XPC_SERVICE_NAME,
      // __CFBundleIdentifier, etc.) that can cause
      // the daemon to take 50+ seconds to start instead of ~1s.
      const home = homedir();
      const bunBinDir = join(home, ".bun", "bin");
      const localBinDir = join(home, ".local", "bin");
      const basePath =
        process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
      const extraDirs = [bunBinDir, localBinDir].filter(
        (d) => !basePath.split(":").includes(d),
      );
      const daemonEnv: Record<string, string> = {
        HOME: process.env.HOME || home,
        PATH: [...extraDirs, basePath].filter(Boolean).join(":"),
      };
      // Forward optional config env vars the daemon may need.
      // `VELLUM_ENVIRONMENT` must be forwarded so the daemon resolves
      // env-scoped paths (device ID, platform/guardian tokens, XDG
      // config dir) to the same location as the CLI that spawned it.
      for (const key of [
        "ANTHROPIC_API_KEY",
        "APP_VERSION",
        "GATEWAY_SECURITY_DIR",
        "CREDENTIAL_SECURITY_DIR",
        "VELLUM_ENVIRONMENT",
        "VELLUM_PLATFORM_URL",
        "QDRANT_HTTP_PORT",
        "QDRANT_URL",
        "RUNTIME_HTTP_PORT",
        "SENTRY_DSN_ASSISTANT",
        "TMPDIR",
        "USER",
        "LANG",
        "VELLUM_DEBUG",
        "VELLUM_DEV",
        "VELLUM_DESKTOP_APP",
        "VELLUM_DISABLE_PLATFORM",
        "VELLUM_WORKSPACE_DIR",
      ]) {
        if (process.env[key]) {
          daemonEnv[key] = process.env[key]!;
        }
      }
      applyDaemonEnvOverrides(daemonEnv, resources, options);

      // Write a sentinel PID file before spawning so concurrent hatch() calls
      // see the file and fall through to the isDaemonResponsive() port check
      // instead of racing to spawn a duplicate daemon.
      writeFileSync(pidFile, "starting", "utf-8");

      const child = foreground
        ? spawn(daemonBinary, [], {
            cwd: dirname(daemonBinary),
            stdio: "inherit",
            env: daemonEnv,
          })
        : (() => {
            const daemonLogFd = openLogFile("hatch.log");
            const c = spawn(daemonBinary, [], {
              cwd: dirname(daemonBinary),
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: daemonEnv,
            });
            pipeToLogFile(c, daemonLogFd, "daemon");
            c.unref();
            return c;
          })();
      const daemonPid = child.pid;

      // Overwrite sentinel with real PID, or clean up on spawn failure.
      if (daemonPid) {
        writeFileSync(pidFile, String(daemonPid), "utf-8");
      } else {
        try {
          unlinkSync(pidFile);
        } catch {}
      }
    }

    // Ensure bun is available for runtime features (browser, skills install)
    // Runs after daemon-reuse checks so the fast attach path is not blocked
    // by a potentially slow bun install when the daemon is already alive.
    if (daemonAlive) {
      ensureBunInstalled();
    }

    // Wait for daemon to respond on HTTP (up to 60s — fresh installs
    // may need 30-60s for Qdrant download, migrations, and first-time init).
    // "migrating" and "failed" both mean the daemon is up and answering, so
    // they don't trigger the source fallback (a restart against the same DB
    // would reproduce the same migration state).
    //
    // Runs only after a fresh spawn: an attached daemon was already
    // classified and logged by resolveProcessState above, and re-waiting on
    // its in-flight migration would just double the reported diagnosis.
    if (!daemonAlive) {
      let readiness = await waitForDaemonMigrationsReady(
        resources.daemonPort,
        Date.now() + 60000,
      );
      const daemonHealthy =
        readiness !== "unreachable" ||
        (await httpHealthCheck(resources.daemonPort));

      // Dev fallback: if the bundled daemon did not become healthy in time,
      // fall back to source daemon startup so local source runs still work.
      if (!daemonHealthy) {
        const assistantIndex = resolveAssistantIndexPath(resources);
        if (assistantIndex) {
          console.log(
            "   Bundled assistant not healthy after 60s — falling back to source assistant...",
          );
          // Kill the bundled daemon to avoid two processes competing for the same port
          await stopProcessByPidFile(pidFile, "bundled daemon");
          if (watch) {
            await startDaemonWatchFromSource(
              assistantIndex,
              resources,
              options,
            );
          } else {
            await startDaemonFromSource(assistantIndex, resources, options);
          }
          readiness = await waitForDaemonMigrationsReady(
            resources.daemonPort,
            Date.now() + 60000,
          );
        }
      } else if (readiness === "unreachable") {
        // The health check just passed, so the readyz probes were the flaky
        // part — re-probe once so the log reports the daemon's real state
        // instead of "did not become ready".
        readiness = await probeDaemonReadiness(resources.daemonPort);
      }

      logDaemonReadiness(readiness);
    }
  } else {
    console.log("🔨 Starting local assistant...");

    const assistantIndex = resolveAssistantIndexPath(resources);
    if (!assistantIndex) {
      throw new Error(
        "vellum-daemon binary not found and assistant source not available.\n" +
          "  Ensure the daemon binary is bundled alongside the CLI, or run from the source tree.",
      );
    }
    const spawned = watch
      ? await startDaemonWatchFromSource(assistantIndex, resources, options)
      : await startDaemonFromSource(assistantIndex, resources, options);
    // Attach case was classified and logged inside the start function.
    if (spawned) {
      logDaemonReadiness(
        await waitForDaemonMigrationsReady(
          resources.daemonPort,
          Date.now() + 60000,
        ),
      );
    }
  }
}

export async function startGateway(
  watch: boolean = false,
  resources?: LocalInstanceResources,
  options?: {
    signingKey?: string;
    bootstrapSecret?: string;
    envOverrides?: Record<string, string>;
  },
): Promise<string> {
  const effectiveGatewayPort = resources?.gatewayPort ?? GATEWAY_PORT;

  // Kill any existing gateway process before spawning a new one.
  // Without this, crashed/stale gateways accumulate as zombies — the old
  // process holds the port (or lingers after losing it), and every restart
  // attempt spawns yet another process that fails with EADDRINUSE.
  const gwPidDir = resources
    ? join(resources.instanceDir, ".vellum")
    : join(homedir(), ".vellum");
  const gwPidFile = join(gwPidDir, "gateway.pid");
  await stopProcessByPidFile(gwPidFile, "gateway");

  const publicUrl = await discoverPublicUrl(effectiveGatewayPort);
  if (publicUrl) {
    console.log(`   HTTP URL: ${publicUrl}`);
  }

  console.log("🌐 Starting gateway...");

  const effectiveDaemonPort =
    resources?.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

  const gatewayEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.envOverrides,
    RUNTIME_HTTP_PORT: String(effectiveDaemonPort),
    GATEWAY_PORT: String(effectiveGatewayPort),
    // Pass gateway operational settings via env vars so the CLI does not
    // need direct access to the workspace config file.
    RUNTIME_PROXY_REQUIRE_AUTH: "true",
    UNMAPPED_POLICY: "default",
    DEFAULT_ASSISTANT_ID: "self",
    ...(options?.signingKey
      ? { ACTOR_TOKEN_SIGNING_KEY: options.signingKey }
      : {}),
    ...(options?.bootstrapSecret
      ? { GUARDIAN_BOOTSTRAP_SECRET: options.bootstrapSecret }
      : {}),
    ...(watch
      ? {
          VELLUM_DEV: "1",
          VELLUM_ENVIRONMENT: process.env.VELLUM_ENVIRONMENT || "local",
        }
      : {}),
    // Pin gateway workspace/security paths to the named instance so parent
    // env vars cannot leak a different workspace. The gateway opens the
    // assistant DB directly for guardian bootstrap.
    ...(resources
      ? {
          VELLUM_WORKSPACE_DIR: join(
            resources.instanceDir,
            ".vellum",
            "workspace",
          ),
          GATEWAY_SECURITY_DIR: join(
            resources.instanceDir,
            ".vellum",
            "protected",
          ),
          CREDENTIAL_SECURITY_DIR: join(
            resources.instanceDir,
            ".vellum",
            "protected",
          ),
        }
      : {}),
  };

  applyIpcSocketDirOverride(gatewayEnv);

  let gateway;

  const runtimeGatewayDir = !watch
    ? localRuntimeGatewayDir(resources)
    : undefined;
  const gatewayBinary = join(dirname(process.execPath), "vellum-gateway");
  if (!runtimeGatewayDir && existsSync(gatewayBinary) && !watch) {
    // Use the compiled gateway binary when available (desktop app or compiled
    // CLI invoked from the terminal). In watch mode, skip the bundled binary
    // and use source (bun --watch only works with source files).
    const gatewayLogFd = openLogFile("hatch.log");
    gateway = spawn(gatewayBinary, [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: gatewayEnv,
    });
    pipeToLogFile(gateway, gatewayLogFd, "gateway");
  } else {
    // Source tree / bunx: resolve the gateway source directory and run via bun.
    const gatewayDir = runtimeGatewayDir ?? resolveGatewayDir(resources);
    const bunArgs = watch
      ? ["--watch", "run", "src/index.ts", "--vellum-gateway"]
      : ["run", "src/index.ts", "--vellum-gateway"];
    const gwLogFd = openLogFile("hatch.log");
    gateway = spawn(resolveBunExecutable(), bunArgs, {
      cwd: gatewayDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithBunPath(gatewayEnv),
    });
    pipeToLogFile(gateway, gwLogFd, "gateway");
    if (watch) {
      console.log("   Gateway started in watch mode (bun --watch)");
    }
  }

  gateway.unref();

  if (gateway.pid) {
    const gwPidDir = resources
      ? join(resources.instanceDir, ".vellum")
      : join(homedir(), ".vellum");
    writeFileSync(join(gwPidDir, "gateway.pid"), String(gateway.pid), "utf-8");
  }

  const gatewayUrl = publicUrl || `http://localhost:${effectiveGatewayPort}`;

  // Wait for the gateway to be responsive before returning. Without this,
  // callers may try to connect before the HTTP server is listening and get
  // connection-refused errors.
  const ready = await waitForDaemonReady(effectiveGatewayPort, 30000);
  if (!ready) {
    console.warn(
      "⚠ Gateway started but health check did not respond within 30s",
    );
  }

  console.log("✅ Gateway started\n");
  return gatewayUrl;
}

/** Check whether a PID belongs to an ngrok process via its command line. */
function isNgrokProcess(pid: number): boolean {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /ngrok/.test(output);
  } catch {
    return false;
  }
}

/**
 * Stop any locally-running daemon and gateway processes
 * and clean up PID files. Called when hatch fails partway through
 * so we don't leave orphaned processes with no lock file entry.
 *
 * When `resources` is provided, uses instance-specific paths instead of
 * the default ~/.vellum/ paths.
 */
export async function stopLocalProcesses(
  resources?: LocalInstanceResources,
): Promise<void> {
  const vellumDir = resources
    ? join(resources.instanceDir, ".vellum")
    : join(homedir(), ".vellum");
  const daemonPidFile = getDaemonPidPath(resources);
  await stopProcessByPidFile(daemonPidFile, "daemon");

  const gatewayPidFile = join(vellumDir, "gateway.pid");
  await stopProcessByPidFile(gatewayPidFile, "gateway", undefined, 7000);

  // Stop the CES sibling if one was launched (CES_STANDALONE). No-op when the
  // PID file is absent, so this is safe on the default topology where the
  // assistant owns CES as an stdio child.
  const cesPidFile = join(vellumDir, "ces.pid");
  await stopProcessByPidFile(cesPidFile, "credential-executor");

  // Kill ngrok directly by PID rather than using stopProcessByPidFile, because
  // isVellumProcess() won't match the ngrok binary — resulting in a no-op that
  // leaves ngrok running. Verify the PID still belongs to ngrok before killing
  // to avoid hitting an unrelated process if the OS has reused the PID.
  const ngrokPidFile = join(vellumDir, "ngrok.pid");
  if (existsSync(ngrokPidFile)) {
    try {
      const pid = parseInt(readFileSync(ngrokPidFile, "utf-8").trim(), 10);
      if (!isNaN(pid) && isNgrokProcess(pid)) {
        await stopProcess(pid, "ngrok");
      }
      unlinkSync(ngrokPidFile);
    } catch {}
  }

  // Stop the nginx ingress if one is fronting this gateway (it guards against
  // PID reuse itself, mirroring the ngrok handling above).
  await stopIngressNginx(join(vellumDir, "workspace"));
}
