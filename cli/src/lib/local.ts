import { execFileSync, execSync, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { homedir, hostname, networkInterfaces, platform } from "os";
import { dirname, join } from "path";

import { type LocalInstanceResources } from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import { httpHealthCheck, waitForDaemonReady } from "./http-client.js";
import { stopProcessByPidFile } from "./process.js";
import { openLogFile, pipeToLogFile } from "./xdg-log.js";

const _require = createRequire(import.meta.url);

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

function resolveAssistantIndexPath(): string | undefined {
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
    const vellumPkgPath = _require.resolve("vellum/package.json");
    const resolved = join(dirname(vellumPkgPath), "src", "index.ts");
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // resolution failed
  }

  return undefined;
}

function ensureBunInstalled(): void {
  const bunBinDir = join(homedir(), ".bun", "bin");
  const pathWithBun = [
    bunBinDir,
    process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  ].join(":");

  try {
    execFileSync("bun", ["--version"], {
      stdio: "pipe",
      env: { ...process.env, PATH: pathWithBun },
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

type DaemonStartOptions = {
  foreground?: boolean;
  defaultWorkspaceConfigPath?: string;
};

async function startDaemonFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<void> {
  const foreground = options?.foreground ?? false;
  const daemonMainPath = resolveDaemonMainPath(assistantIndex);

  // Ensure the directory containing PID/socket files exists. For named
  // instances this is instanceDir/.vellum/ (matching daemon's getRootDir()).
  mkdirSync(dirname(resources.pidFile), { recursive: true });

  const pidFile = resources.pidFile;

  // --- Lifecycle guard: prevent split-brain daemon state ---
  if (existsSync(pidFile)) {
    try {
      const content = readFileSync(pidFile, "utf-8").trim();

      // Another caller is already spawning the daemon — wait for it
      // instead of racing to spawn a duplicate.
      if (content === "starting") {
        console.log(
          "   Assistant is starting — waiting for it to become ready...",
        );
        if (await waitForDaemonReady(resources.daemonPort, 60000)) {
          console.log("   Assistant is ready\n");
          return;
        }
        // The other spawn may have failed; clean up and proceed to spawn.
        try {
          unlinkSync(pidFile);
        } catch {}
      }

      const pid = parseInt(content, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`   Assistant already running (pid ${pid})\n`);
          return;
        } catch {
          try {
            unlinkSync(pidFile);
          } catch {}
        }
      }
    } catch {}
  }

  // PID file was stale or missing — check if daemon is responding via HTTP
  if (await isDaemonResponsive(resources.daemonPort)) {
    // Recover PID tracking so lifecycle commands (sleep, retire,
    // stopLocalProcesses) can manage this daemon process.
    const recoveredPid = recoverPidFile(pidFile, resources.daemonPort);
    if (recoveredPid) {
      console.log(
        `   Assistant is responsive (pid ${recoveredPid}) — skipping restart\n`,
      );
    } else {
      console.log("   Assistant is responsive — skipping restart\n");
    }
    return;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    VELLUM_CLOUD: "local",
  };
  if (resources) {
    env.BASE_DATA_DIR = resources.instanceDir;
    env.RUNTIME_HTTP_PORT = String(resources.daemonPort);
    env.GATEWAY_PORT = String(resources.gatewayPort);
    env.QDRANT_HTTP_PORT = String(resources.qdrantPort);
    delete env.QDRANT_URL;
  }
  if (options?.defaultWorkspaceConfigPath) {
    env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
      options.defaultWorkspaceConfigPath;
  }

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const child = foreground
    ? spawn("bun", ["run", daemonMainPath], {
        stdio: "inherit",
        env,
      })
    : (() => {
        const daemonLogFd = openLogFile("hatch.log");
        const c = spawn("bun", ["run", daemonMainPath], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
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
}

// NOTE: startDaemonWatchFromSource() is the CLI-side watch-mode daemon
// launcher. Its lifecycle guards should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
async function startDaemonWatchFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<void> {
  const mainPath = resolveDaemonMainPath(assistantIndex);
  if (!existsSync(mainPath)) {
    throw new Error(`Daemon main.ts not found at ${mainPath}`);
  }

  mkdirSync(dirname(resources.pidFile), { recursive: true });

  const pidFile = resources.pidFile;

  // --- Lifecycle guard: prevent split-brain daemon state ---
  // If a daemon is already running, skip spawning a new one.
  if (existsSync(pidFile)) {
    try {
      const content = readFileSync(pidFile, "utf-8").trim();

      // Another caller is already spawning the daemon — wait for it
      // instead of racing to spawn a duplicate.
      if (content === "starting") {
        console.log(
          "   Assistant is starting — waiting for it to become ready...",
        );
        if (await waitForDaemonReady(resources.daemonPort, 60000)) {
          console.log("   Assistant is ready\n");
          return;
        }
        // The other spawn may have failed; clean up and proceed to spawn.
        try {
          unlinkSync(pidFile);
        } catch {}
      }

      const pid = parseInt(content, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // Check if alive
          console.log(`   Assistant already running (pid ${pid})\n`);
          return;
        } catch {
          // Process doesn't exist, clean up stale PID file
          try {
            unlinkSync(pidFile);
          } catch {}
        }
      }
    } catch {}
  }

  // PID file was stale or missing — check if daemon is responding via HTTP
  if (await isDaemonResponsive(resources.daemonPort)) {
    // Recover PID tracking so lifecycle commands (sleep, retire,
    // stopLocalProcesses) can manage this daemon process.
    const recoveredPid = recoverPidFile(pidFile, resources.daemonPort);
    if (recoveredPid) {
      console.log(
        `   Assistant is responsive (pid ${recoveredPid}) — skipping restart\n`,
      );
    } else {
      console.log("   Assistant is responsive — skipping restart\n");
    }
    return;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    VELLUM_DEV: "1",
  };
  if (resources) {
    env.BASE_DATA_DIR = resources.instanceDir;
    env.RUNTIME_HTTP_PORT = String(resources.daemonPort);
    env.GATEWAY_PORT = String(resources.gatewayPort);
    env.QDRANT_HTTP_PORT = String(resources.qdrantPort);
    delete env.QDRANT_URL;
  }
  if (options?.defaultWorkspaceConfigPath) {
    env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
      options.defaultWorkspaceConfigPath;
  }

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const daemonLogFd = openLogFile("hatch.log");
  const child = spawn("bun", ["--watch", "run", mainPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
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
}

function resolveGatewayDir(): string {
  // Source tree: cli/src/lib/ → ../../.. → repo root → gateway/
  const sourceDir = join(import.meta.dir, "..", "..", "..", "gateway");
  if (isGatewaySourceDir(sourceDir)) {
    return sourceDir;
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

function normalizeIngressUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || undefined;
}

// ── Workspace config helpers ──

function getWorkspaceConfigPath(instanceDir?: string): string {
  const baseDataDir =
    instanceDir ??
    (process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? homedir()));
  return join(baseDataDir, ".vellum", "workspace", "config.json");
}

function loadWorkspaceConfig(instanceDir?: string): Record<string, unknown> {
  const configPath = getWorkspaceConfigPath(instanceDir);
  try {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function saveWorkspaceConfig(
  config: Record<string, unknown>,
  instanceDir?: string,
): void {
  const configPath = getWorkspaceConfigPath(instanceDir);
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Write gateway operational settings to the workspace config file so the
 * gateway reads them at startup via its config.ts readWorkspaceConfig().
 */
function writeGatewayConfig(
  instanceDir?: string,
  opts?: {
    runtimeProxyEnabled?: boolean;
    runtimeProxyRequireAuth?: boolean;
    unmappedPolicy?: "reject" | "default";
    defaultAssistantId?: string;
    routingEntries?: Array<{
      type: "conversation_id" | "actor_id";
      key: string;
      assistantId: string;
    }>;
  },
): void {
  const config = loadWorkspaceConfig(instanceDir);
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;

  if (opts?.runtimeProxyEnabled !== undefined) {
    gateway.runtimeProxyEnabled = opts.runtimeProxyEnabled;
  }
  if (opts?.runtimeProxyRequireAuth !== undefined) {
    gateway.runtimeProxyRequireAuth = opts.runtimeProxyRequireAuth;
  }
  if (opts?.unmappedPolicy !== undefined) {
    gateway.unmappedPolicy = opts.unmappedPolicy;
  }
  if (opts?.defaultAssistantId !== undefined) {
    gateway.defaultAssistantId = opts.defaultAssistantId;
  }
  if (opts?.routingEntries !== undefined) {
    gateway.routingEntries = opts.routingEntries;
  }

  config.gateway = gateway;
  saveWorkspaceConfig(config, instanceDir);
}

function readWorkspaceIngressPublicBaseUrl(
  instanceDir?: string,
): string | undefined {
  const baseDataDir =
    instanceDir ??
    (process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? homedir()));
  const workspaceConfigPath = join(
    baseDataDir,
    ".vellum",
    "workspace",
    "config.json",
  );
  try {
    const raw = JSON.parse(
      readFileSync(workspaceConfigPath, "utf-8"),
    ) as Record<string, unknown>;
    const ingress = raw.ingress as Record<string, unknown> | undefined;
    return normalizeIngressUrl(ingress?.publicBaseUrl);
  } catch {
    return undefined;
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

  // Log the local address source only when we actually use it.
  if (localResult.source === "hostname") {
    console.log(`   Discovered macOS local hostname: ${localResult.label}`);
  } else if (localResult.source === "lan") {
    console.log(`   Discovered LAN IP: ${localResult.label}`);
  }

  return localResult.url;
}

/**
 * Resolve a LAN-reachable URL without any async I/O. Returns the best local
 * address or falls back to localhost. Does not emit any logs — the caller
 * decides whether to log based on which result is actually used.
 */
function discoverLocalUrl(effectivePort: number): {
  url: string;
  source: "hostname" | "lan" | "localhost";
  label?: string;
} {
  // On macOS, prefer the .local hostname (Bonjour/mDNS) so other devices on
  // the same network can reach the gateway by name.
  if (platform() === "darwin") {
    const localHostname = getMacLocalHostname();
    if (localHostname) {
      return {
        url: `http://${localHostname}:${effectivePort}`,
        source: "hostname",
        label: localHostname,
      };
    }
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    return {
      url: `http://${lanIp}:${effectivePort}`,
      source: "lan",
      label: lanIp,
    };
  }

  // Final fallback to localhost when no LAN address could be discovered.
  return {
    url: `http://localhost:${effectivePort}`,
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
 * Returns the macOS Bonjour/mDNS `.local` hostname (e.g. "Vargass-Mac-Mini.local"),
 * or undefined if not running on macOS or the hostname cannot be determined.
 */
export function getMacLocalHostname(): string | undefined {
  const host = hostname();
  if (!host) return undefined;
  // macOS hostnames already end with .local when Bonjour is active
  if (host.endsWith(".local")) return host;
  // Otherwise, append .local — macOS resolves <ComputerName>.local via mDNS
  return `${host}.local`;
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

// NOTE: startLocalDaemon() is the CLI-side daemon lifecycle manager.
// It should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
export async function startLocalDaemon(
  watch: boolean = false,
  resources: LocalInstanceResources,
  options?: DaemonStartOptions,
): Promise<void> {
  const foreground = options?.foreground ?? false;
  // Check for a compiled daemon binary adjacent to the CLI executable.
  // This covers both the desktop app (VELLUM_DESKTOP_APP) and the case where
  // the user runs the compiled CLI directly from the terminal (e.g. via a
  // /usr/local/bin/vellum symlink into the app bundle).
  const daemonBinary = join(dirname(process.execPath), "vellum-daemon");
  if (existsSync(daemonBinary) && !watch) {
    // In watch mode, skip the bundled binary and use source (bun --watch
    // only works with source files, not compiled binaries).

    const pidFile = resources.pidFile;

    // If a daemon is already running, skip spawning a new one.
    // This prevents cascading kill→restart cycles when multiple callers
    // invoke hatch() concurrently (setupDaemonClient + ensureDaemonConnected).
    let daemonAlive = false;
    if (existsSync(pidFile)) {
      try {
        const content = readFileSync(pidFile, "utf-8").trim();

        // Another caller is already spawning the daemon — wait for it
        // instead of racing to spawn a duplicate.
        if (content === "starting") {
          console.log(
            "   Assistant is starting — waiting for it to become ready...",
          );
          if (await waitForDaemonReady(resources.daemonPort, 60000)) {
            console.log("   Assistant is ready\n");
            ensureBunInstalled();
            return;
          }
          // The other spawn may have failed; clean up and proceed to spawn.
          try {
            unlinkSync(pidFile);
          } catch {}
        }

        const pid = parseInt(content, 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // Check if alive
            daemonAlive = true;
            console.log(`   Assistant already running (pid ${pid})\n`);
          } catch {
            // Process doesn't exist, clean up stale PID file
            try {
              unlinkSync(pidFile);
            } catch {}
          }
        }
      } catch {}
    }

    if (!daemonAlive) {
      // The PID file was stale or missing, but a daemon with a different PID
      // may still be listening on the HTTP port (e.g. if the PID file was
      // overwritten by a crashed restart attempt). Check before starting a new one.
      if (await isDaemonResponsive(resources.daemonPort)) {
        // Restore PID tracking so lifecycle commands (sleep, retire,
        // stopLocalProcesses) can manage this daemon process.
        const recoveredPid = recoverPidFile(pidFile, resources.daemonPort);
        if (recoveredPid) {
          console.log(
            `   Assistant is responsive (pid ${recoveredPid}) — skipping restart\n`,
          );
        } else {
          console.log("   Assistant is responsive — skipping restart\n");
        }
        // Ensure bun is available for runtime features (browser, skills install)
        // even when reusing an existing daemon.
        ensureBunInstalled();
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
      // Forward optional config env vars the daemon may need
      for (const key of [
        "ANTHROPIC_API_KEY",
        "APP_VERSION",
        "BASE_DATA_DIR",
        "VELLUM_PLATFORM_URL",
        "QDRANT_HTTP_PORT",
        "QDRANT_URL",
        "RUNTIME_HTTP_PORT",
        "SENTRY_DSN_ASSISTANT",
        "TMPDIR",
        "USER",
        "LANG",
        "VELLUM_DEBUG",
        "VELLUM_DESKTOP_APP",
      ]) {
        if (process.env[key]) {
          daemonEnv[key] = process.env[key]!;
        }
      }
      if (options?.defaultWorkspaceConfigPath) {
        daemonEnv.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
          options.defaultWorkspaceConfigPath;
      }
      // When running a named instance, override env so the daemon resolves
      // all paths under the instance directory and listens on its own port.
      if (resources) {
        daemonEnv.BASE_DATA_DIR = resources.instanceDir;
        daemonEnv.RUNTIME_HTTP_PORT = String(resources.daemonPort);
        daemonEnv.GATEWAY_PORT = String(resources.gatewayPort);
        daemonEnv.QDRANT_HTTP_PORT = String(resources.qdrantPort);
        delete daemonEnv.QDRANT_URL;
      }

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
    // may need 30-60s for Qdrant download, migrations, and first-time init)
    let daemonReady = await waitForDaemonReady(resources.daemonPort, 60000);

    // Dev fallback: if the bundled daemon did not become ready in time,
    // fall back to source daemon startup so local `./build.sh run` still works.
    if (!daemonReady) {
      const assistantIndex = resolveAssistantIndexPath();
      if (assistantIndex) {
        console.log(
          "   Bundled assistant not ready after 60s — falling back to source assistant...",
        );
        // Kill the bundled daemon to avoid two processes competing for the same port
        await stopProcessByPidFile(pidFile, "bundled daemon");
        if (watch) {
          await startDaemonWatchFromSource(assistantIndex, resources, options);
        } else {
          await startDaemonFromSource(assistantIndex, resources, options);
        }
        daemonReady = await waitForDaemonReady(resources.daemonPort, 60000);
      }
    }

    if (daemonReady) {
      console.log("   Assistant ready\n");
    } else {
      console.log(
        "   ⚠️  Assistant did not become ready within 60s — continuing anyway\n",
      );
    }
  } else {
    console.log("🔨 Starting local assistant...");

    const assistantIndex = resolveAssistantIndexPath();
    if (!assistantIndex) {
      throw new Error(
        "vellum-daemon binary not found and assistant source not available.\n" +
          "  Ensure the daemon binary is bundled alongside the CLI, or run from the source tree.",
      );
    }
    if (watch) {
      await startDaemonWatchFromSource(assistantIndex, resources, options);

      const daemonReady = await waitForDaemonReady(resources.daemonPort, 60000);
      if (daemonReady) {
        console.log("   Assistant ready\n");
      } else {
        console.log(
          "   ⚠️  Assistant did not become ready within 60s — continuing anyway\n",
        );
      }
    } else {
      await startDaemonFromSource(assistantIndex, resources, options);

      const daemonReady = await waitForDaemonReady(resources.daemonPort, 60000);
      if (daemonReady) {
        console.log("   Assistant ready\n");
      } else {
        console.log(
          "   ⚠️  Assistant did not become ready within 60s — continuing anyway\n",
        );
      }
    }
  }
}

export async function startGateway(
  watch: boolean = false,
  resources?: LocalInstanceResources,
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
    console.log(`   Public URL: ${publicUrl}`);
  }

  console.log("🌐 Starting gateway...");

  const effectiveDaemonPort =
    resources?.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

  // Write gateway operational settings to workspace config before starting
  // the gateway process. The gateway reads these at startup from config.json.
  writeGatewayConfig(resources?.instanceDir, {
    runtimeProxyEnabled: true,
    runtimeProxyRequireAuth: true,
    unmappedPolicy: "default",
    defaultAssistantId: "self",
  });

  const gatewayEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RUNTIME_HTTP_PORT: String(effectiveDaemonPort),
    GATEWAY_PORT: String(effectiveGatewayPort),
    ...(watch ? { VELLUM_DEV: "1" } : {}),
    // Set BASE_DATA_DIR so the gateway loads the correct signing key and
    // credentials for this instance (mirrors the daemon env setup).
    ...(resources ? { BASE_DATA_DIR: resources.instanceDir } : {}),
  };
  // The gateway reads the ingress URL from the workspace config file via
  // ConfigFileCache — no env var passthrough needed. Log the resolved value
  // for diagnostic visibility during startup.
  const workspaceIngressPublicBaseUrl = readWorkspaceIngressPublicBaseUrl(
    resources?.instanceDir,
  );
  const ingressPublicBaseUrl = workspaceIngressPublicBaseUrl ?? publicUrl;
  if (ingressPublicBaseUrl) {
    console.log(`   Ingress URL: ${ingressPublicBaseUrl}`);
  }

  let gateway;

  const gatewayBinary = join(dirname(process.execPath), "vellum-gateway");
  if (existsSync(gatewayBinary) && !watch) {
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
    const gatewayDir = resolveGatewayDir();
    const bunArgs = watch
      ? ["--watch", "run", "src/index.ts", "--vellum-gateway"]
      : ["run", "src/index.ts", "--vellum-gateway"];
    const gwLogFd = openLogFile("hatch.log");
    gateway = spawn("bun", bunArgs, {
      cwd: gatewayDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: gatewayEnv,
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
  // callers (e.g. displayPairingQRCode) may try to connect before the HTTP
  // server is listening and get connection-refused errors.
  const start = Date.now();
  const timeoutMs = 30000;
  let ready = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(
        `http://localhost:${effectiveGatewayPort}/healthz`,
        {
          signal: AbortSignal.timeout(2000),
        },
      );
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Gateway not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    console.warn(
      "⚠ Gateway started but health check did not respond within 30s",
    );
  }

  console.log("✅ Gateway started\n");
  return gatewayUrl;
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
  const daemonPidFile = resources?.pidFile ?? join(vellumDir, "vellum.pid");
  await stopProcessByPidFile(daemonPidFile, "daemon");

  const gatewayPidFile = join(vellumDir, "gateway.pid");
  await stopProcessByPidFile(gatewayPidFile, "gateway", undefined, 7000);

  // Kill ngrok directly by PID rather than using stopProcessByPidFile, because
  // isVellumProcess() won't match the ngrok binary — resulting in a no-op that
  // leaves ngrok running.
  const ngrokPidFile = join(vellumDir, "ngrok.pid");
  if (existsSync(ngrokPidFile)) {
    try {
      const pid = parseInt(readFileSync(ngrokPidFile, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      unlinkSync(ngrokPidFile);
    } catch {}
  }
}
