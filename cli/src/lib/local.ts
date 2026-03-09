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

import {
  loadLatestAssistant,
  type LocalInstanceResources,
} from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";
import { httpHealthCheck, waitForDaemonReady } from "./http-client.js";
import { stopProcessByPidFile } from "./process.js";
import { openLogFile, openLogPipe, pipeToLogFile } from "./xdg-log.js";

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

async function startDaemonFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
): Promise<void> {
  const daemonMainPath = resolveDaemonMainPath(assistantIndex);

  // Ensure the directory containing PID/socket files exists. For named
  // instances this is instanceDir/.vellum/ (matching daemon's getRootDir()).
  mkdirSync(dirname(resources.pidFile), { recursive: true });

  const pidFile = resources.pidFile;

  // --- Lifecycle guard: prevent split-brain daemon state ---
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
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
  };
  // Preserve TCP listener flag when falling back from bundled desktop daemon
  if (process.env.VELLUM_DESKTOP_APP) {
    env.VELLUM_DAEMON_TCP_ENABLED =
      process.env.VELLUM_DAEMON_TCP_ENABLED || "1";
  }
  if (resources) {
    env.BASE_DATA_DIR = resources.instanceDir;
    env.RUNTIME_HTTP_PORT = String(resources.daemonPort);
    env.GATEWAY_PORT = String(resources.gatewayPort);
    env.QDRANT_HTTP_PORT = String(resources.qdrantPort);
    delete env.QDRANT_URL;
  }

  const logPipe = openLogPipe("hatch.log", "daemon");
  const child = spawn("bun", ["run", daemonMainPath], {
    detached: true,
    stdio: ["ignore", logPipe.stdio, logPipe.stdio],
    env,
  });
  logPipe.detach();
  child.unref();

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid), "utf-8");
  }
}

// NOTE: startDaemonWatchFromSource() is the CLI-side watch-mode daemon
// launcher. Its lifecycle guards should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
async function startDaemonWatchFromSource(
  assistantIndex: string,
  resources: LocalInstanceResources,
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
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
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

  const daemonLogFd = openLogFile("hatch.log");
  const child = spawn("bun", ["--watch", "run", mainPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  pipeToLogFile(child, daemonLogFd, "daemon");
  child.unref();
  const daemonPid = child.pid;

  if (daemonPid) {
    writeFileSync(pidFile, String(daemonPid), "utf-8");
  }

  console.log("   Assistant started in watch mode (bun --watch)");
}

function resolveGatewayDir(): string {
  const override = process.env.VELLUM_GATEWAY_DIR?.trim();
  if (override) {
    if (!isGatewaySourceDir(override)) {
      throw new Error(
        `VELLUM_GATEWAY_DIR is set to "${override}", but it is not a valid gateway source directory.`,
      );
    }
    return override;
  }

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
      "Gateway not found. Ensure @vellumai/vellum-gateway is installed, run from the source tree, or set VELLUM_GATEWAY_DIR.",
    );
  }
}

function normalizeIngressUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || undefined;
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

export async function discoverPublicUrl(port?: number): Promise<string | undefined> {
  const effectivePort = port ?? GATEWAY_PORT;
  const cloud = process.env.VELLUM_CLOUD;

  let externalIp: string | undefined;

  // Try cloud-specific metadata services for GCP and AWS.
  if (cloud === "gcp" || cloud === "aws") {
    try {
      if (cloud === "gcp") {
        const resp = await fetch(
          "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
          { headers: { "Metadata-Flavor": "Google" } },
        );
        if (resp.ok) externalIp = (await resp.text()).trim();
      } else if (cloud === "aws") {
        // Use IMDSv2 (token-based) for compatibility with HttpTokens=required
        const tokenResp = await fetch(
          "http://169.254.169.254/latest/api/token",
          {
            method: "PUT",
            headers: { "X-aws-ec2-metadata-token-ttl-seconds": "30" },
          },
        );
        if (tokenResp.ok) {
          const token = await tokenResp.text();
          const ipResp = await fetch(
            "http://169.254.169.254/latest/meta-data/public-ipv4",
            { headers: { "X-aws-ec2-metadata-token": token } },
          );
          if (ipResp.ok) externalIp = (await ipResp.text()).trim();
        }
      }
    } catch {
      // metadata service not reachable
    }

    if (externalIp) {
      console.log(`   Discovered external IP: ${externalIp}`);
      return `http://${externalIp}:${effectivePort}`;
    }
  }

  // For local and custom environments, use the local LAN address.
  // On macOS, prefer the .local hostname (Bonjour/mDNS) so other devices on
  // the same network can reach the gateway by name.
  if (platform() === "darwin") {
    const localHostname = getMacLocalHostname();
    if (localHostname) {
      console.log(`   Discovered macOS local hostname: ${localHostname}`);
      return `http://${localHostname}:${effectivePort}`;
    }
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    console.log(`   Discovered LAN IP: ${lanIp}`);
    return `http://${lanIp}:${effectivePort}`;
  }

  // Final fallback to localhost when no LAN address could be discovered.
  return `http://localhost:${effectivePort}`;
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

// NOTE: startLocalDaemon() is the CLI-side daemon lifecycle manager.
// It should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
export async function startLocalDaemon(
  watch: boolean = false,
  resources: LocalInstanceResources,
): Promise<void> {
  if (process.env.VELLUM_DESKTOP_APP && !watch) {
    // When running inside the desktop app, the CLI owns the daemon lifecycle.
    // Find the vellum-daemon binary adjacent to the CLI binary.
    // In watch mode, skip the bundled binary and use source (bun --watch
    // only works with source files, not compiled binaries).
    const daemonBinary = join(dirname(process.execPath), "vellum-daemon");
    if (!existsSync(daemonBinary)) {
      throw new Error(
        `vellum-daemon binary not found at ${daemonBinary}.\n` +
          "  Ensure the daemon binary is bundled alongside the CLI in the app bundle.",
      );
    }

    const pidFile = resources.pidFile;

    // If a daemon is already running, skip spawning a new one.
    // This prevents cascading kill→restart cycles when multiple callers
    // invoke hatch() concurrently (setupDaemonClient + ensureDaemonConnected).
    let daemonAlive = false;
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
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
      // __CFBundleIdentifier, CLAUDE_CODE_ENTRYPOINT, etc.) that can cause
      // the daemon to take 50+ seconds to start instead of ~1s.
      const bunBinDir = join(homedir(), ".bun", "bin");
      const basePath =
        process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
      const daemonEnv: Record<string, string> = {
        HOME: process.env.HOME || homedir(),
        PATH: `${bunBinDir}:${basePath}`,
        VELLUM_DAEMON_TCP_ENABLED: "1",
      };
      // Forward optional config env vars the daemon may need
      for (const key of [
        "ANTHROPIC_API_KEY",
        "BASE_DATA_DIR",
        "QDRANT_HTTP_PORT",
        "QDRANT_URL",
        "RUNTIME_HTTP_PORT",
        "VELLUM_DAEMON_TCP_PORT",
        "VELLUM_DAEMON_TCP_HOST",
        "VELLUM_KEYCHAIN_BROKER_SOCKET",
        "VELLUM_DEBUG",
        "SENTRY_DSN",
        "TMPDIR",
        "USER",
        "LANG",
      ]) {
        if (process.env[key]) {
          daemonEnv[key] = process.env[key]!;
        }
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

      const daemonLogPipe = openLogPipe("hatch.log", "daemon");
      const child = spawn(daemonBinary, [], {
        cwd: dirname(daemonBinary),
        detached: true,
        stdio: ["ignore", daemonLogPipe.stdio, daemonLogPipe.stdio],
        env: daemonEnv,
      });
      daemonLogPipe.detach();
      child.unref();
      const daemonPid = child.pid;

      // Write PID file immediately so the health monitor can find the process
      // and concurrent hatch() calls see it as alive.
      if (daemonPid) {
        writeFileSync(pidFile, String(daemonPid), "utf-8");
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
          await startDaemonWatchFromSource(assistantIndex, resources);
        } else {
          await startDaemonFromSource(assistantIndex, resources);
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
      await startDaemonWatchFromSource(assistantIndex, resources);

      const daemonReady = await waitForDaemonReady(resources.daemonPort, 60000);
      if (daemonReady) {
        console.log("   Assistant ready\n");
      } else {
        console.log(
          "   ⚠️  Assistant did not become ready within 60s — continuing anyway\n",
        );
      }
    } else {
      await startDaemonFromSource(assistantIndex, resources);

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
  assistantId?: string,
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

  // Resolve the default assistant ID for the gateway. Prefer the explicitly
  // provided assistantId (from hatch), then env override, then lockfile.
  const resolvedAssistantId =
    assistantId ||
    process.env.GATEWAY_DEFAULT_ASSISTANT_ID ||
    loadLatestAssistant()?.assistantId;

  // Read the bearer token so the gateway can authenticate proxied requests
  // (e.g. from paired iOS devices). Respect VELLUM_HTTP_TOKEN_PATH and
  // BASE_DATA_DIR for consistency with gateway/config.ts and the daemon.
  // When resources are provided, the token lives under the instance directory.
  const httpTokenPath =
    process.env.VELLUM_HTTP_TOKEN_PATH ??
    (resources
      ? join(resources.instanceDir, ".vellum", "http-token")
      : join(
          process.env.BASE_DATA_DIR?.trim() || homedir(),
          ".vellum",
          "http-token",
        ));
  let runtimeProxyBearerToken: string | undefined;
  try {
    const tok = readFileSync(httpTokenPath, "utf-8").trim();
    if (tok) runtimeProxyBearerToken = tok;
  } catch {
    // Token file doesn't exist yet — daemon hasn't written it.
  }

  // If no token is available (first startup — daemon hasn't written it yet),
  // poll for the file to appear. On fresh installs the daemon may take 60s+
  // for Qdrant download, migrations, and first-time init. Starting the
  // gateway without auth is a security risk since the config is loaded once
  // at startup and never reloads, so we fail rather than silently disabling auth.
  if (!runtimeProxyBearerToken) {
    console.log("   Waiting for bearer token file...");
    const maxWait = 60000;
    const pollInterval = 500;
    const start = Date.now();
    const pidFile =
      resources?.pidFile ??
      join(
        process.env.BASE_DATA_DIR?.trim() || homedir(),
        ".vellum",
        "vellum.pid",
      );
    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const tok = readFileSync(httpTokenPath, "utf-8").trim();
        if (tok) {
          runtimeProxyBearerToken = tok;
          break;
        }
      } catch {
        // File still doesn't exist, keep polling.
      }
      // Check if the daemon process is still alive — no point waiting if it crashed
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (pid) process.kill(pid, 0); // throws if process doesn't exist
      } catch {
        break; // daemon process is gone
      }
    }
  }

  if (!runtimeProxyBearerToken) {
    throw new Error(
      `Bearer token file not found at ${httpTokenPath} after 60s.\n` +
        "  The gateway cannot start without authentication — this would leave the proxy permanently unauthenticated.\n" +
        "  Ensure the daemon is running and has written the token file, or set VELLUM_HTTP_TOKEN_PATH to the correct path.",
    );
  }
  const effectiveDaemonPort =
    resources?.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

  const gatewayEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GATEWAY_RUNTIME_PROXY_ENABLED: "true",
    GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "true",
    RUNTIME_PROXY_BEARER_TOKEN: runtimeProxyBearerToken,
    RUNTIME_HTTP_PORT: String(effectiveDaemonPort),
    GATEWAY_PORT: String(effectiveGatewayPort),
    // Skip the drain window for locally-launched gateways — there is no load
    // balancer draining connections, so waiting serves no purpose and causes
    // `vellum sleep` to SIGKILL the gateway when the CLI timeout is shorter
    // than the drain window.  Respect an explicit env override.
    GATEWAY_SHUTDOWN_DRAIN_MS: process.env.GATEWAY_SHUTDOWN_DRAIN_MS || "0",
    ...(watch ? { VELLUM_DEV: "1" } : {}),
    // Set BASE_DATA_DIR so the gateway loads the correct signing key and
    // credentials for this instance (mirrors the daemon env setup).
    ...(resources ? { BASE_DATA_DIR: resources.instanceDir } : {}),
  };

  if (process.env.GATEWAY_UNMAPPED_POLICY) {
    gatewayEnv.GATEWAY_UNMAPPED_POLICY = process.env.GATEWAY_UNMAPPED_POLICY;
  } else {
    gatewayEnv.GATEWAY_UNMAPPED_POLICY = "default";
  }

  if (resolvedAssistantId) {
    gatewayEnv.GATEWAY_DEFAULT_ASSISTANT_ID = resolvedAssistantId;
  }
  const workspaceIngressPublicBaseUrl = readWorkspaceIngressPublicBaseUrl(
    resources?.instanceDir,
  );
  const ingressPublicBaseUrl =
    workspaceIngressPublicBaseUrl ??
    normalizeIngressUrl(process.env.INGRESS_PUBLIC_BASE_URL) ??
    publicUrl;
  if (ingressPublicBaseUrl) {
    gatewayEnv.INGRESS_PUBLIC_BASE_URL = ingressPublicBaseUrl;
    console.log(`   Ingress URL: ${ingressPublicBaseUrl}`);
  }

  let gateway;

  if (process.env.VELLUM_DESKTOP_APP && !watch) {
    // Desktop app: spawn the compiled gateway binary directly (mirrors daemon pattern).
    // In watch mode, skip the bundled binary and use source (bun --watch
    // only works with source files, not compiled binaries).
    const gatewayBinary = join(dirname(process.execPath), "vellum-gateway");
    if (!existsSync(gatewayBinary)) {
      throw new Error(
        `vellum-gateway binary not found at ${gatewayBinary}.\n` +
          "  Ensure the gateway binary is bundled alongside the CLI in the app bundle.",
      );
    }

    const gatewayLogPipe = openLogPipe("hatch.log", "gateway");
    gateway = spawn(gatewayBinary, [], {
      detached: true,
      stdio: ["ignore", gatewayLogPipe.stdio, gatewayLogPipe.stdio],
      env: gatewayEnv,
    });
    gatewayLogPipe.detach();
  } else {
    // Source tree / bunx: resolve the gateway source directory and run via bun.
    const gatewayDir = resolveGatewayDir();
    const bunArgs = watch
      ? ["--watch", "run", "src/index.ts", "--vellum-gateway"]
      : ["run", "src/index.ts", "--vellum-gateway"];
    const gwLogPipe = openLogPipe("hatch.log", "gateway");
    gateway = spawn("bun", bunArgs, {
      cwd: gatewayDir,
      detached: true,
      stdio: ["ignore", gwLogPipe.stdio, gwLogPipe.stdio],
      env: gatewayEnv,
    });
    gwLogPipe.detach();
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
}
