import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join } from "path";

import { loadAllAssistants, loadLatestAssistant } from "./assistant-config.js";
import { GATEWAY_PORT } from "./constants.js";

const _require = createRequire(import.meta.url);

function isGatewaySourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "index.ts"))) return false;
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

  const sourceDir = join(import.meta.dir, "..", "..", "..", "gateway");
  if (isGatewaySourceDir(sourceDir)) {
    return sourceDir;
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

function readWorkspaceIngressPublicBaseUrl(): string | undefined {
  const baseDataDir = process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? homedir());
  const workspaceConfigPath = join(baseDataDir, ".vellum", "workspace", "config.json");
  try {
    const raw = JSON.parse(readFileSync(workspaceConfigPath, "utf-8")) as Record<string, unknown>;
    const ingress = raw.ingress as Record<string, unknown> | undefined;
    return normalizeIngressUrl(ingress?.publicBaseUrl);
  } catch {
    return undefined;
  }
}

async function discoverPublicUrl(): Promise<string | undefined> {
  const cloud = process.env.VELLUM_CLOUD;
  if (!cloud || cloud === "local") {
    return `http://localhost:${GATEWAY_PORT}`;
  }

  let externalIp: string | undefined;
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
        { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "30" } },
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
    return `http://${externalIp}:${GATEWAY_PORT}`;
  }
  return undefined;
}

export async function startLocalDaemon(): Promise<void> {
  if (process.env.VELLUM_DESKTOP_APP) {
    // When running inside the desktop app, the CLI owns the daemon lifecycle.
    // Find the vellum-daemon binary adjacent to the CLI binary.
    const daemonBinary = join(dirname(process.execPath), "vellum-daemon");
    if (!existsSync(daemonBinary)) {
      throw new Error(
        `vellum-daemon binary not found at ${daemonBinary}.\n` +
          "  Ensure the daemon binary is bundled alongside the CLI in the app bundle.",
      );
    }

    const vellumDir = join(homedir(), ".vellum");
    const pidFile = join(vellumDir, "vellum.pid");
    const socketFile = join(vellumDir, "vellum.sock");

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
            console.log(`   Daemon already running (pid ${pid})\n`);
          } catch {
            // Process doesn't exist, clean up stale PID file
            try { unlinkSync(pidFile); } catch {}
          }
        }
      } catch {}
    }

    if (!daemonAlive) {
      // Remove stale socket so we can detect the fresh one
      try { unlinkSync(socketFile); } catch {}

      console.log("🔨 Starting daemon...");

      // Ensure ~/.vellum/ exists for PID/socket files
      mkdirSync(vellumDir, { recursive: true });

      // Build a minimal environment for the daemon. When launched from the
      // macOS app the CLI inherits a huge environment (XPC_SERVICE_NAME,
      // __CFBundleIdentifier, CLAUDE_CODE_ENTRYPOINT, etc.) that can cause
      // the daemon to take 50+ seconds to start instead of ~1s.
      const daemonEnv: Record<string, string> = {
        HOME: process.env.HOME || homedir(),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        VELLUM_DAEMON_TCP_ENABLED: "1",
      };
      // Forward optional config env vars the daemon may need
      for (const key of [
        "ANTHROPIC_API_KEY",
        "BASE_DATA_DIR",
        "VELLUM_DAEMON_TCP_PORT",
        "VELLUM_DAEMON_TCP_HOST",
        "VELLUM_DAEMON_SOCKET",
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

      const child = spawn(daemonBinary, [], {
        detached: true,
        stdio: "ignore",
        env: daemonEnv,
      });
      child.unref();

      // Write PID file immediately so the health monitor can find the process
      // and concurrent hatch() calls see it as alive.
      if (child.pid) {
        writeFileSync(pidFile, String(child.pid), "utf-8");
      }
    }

    // Wait for socket at ~/.vellum/vellum.sock (up to 15s)
    if (!existsSync(socketFile)) {
      const maxWait = 15000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        if (existsSync(socketFile)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (existsSync(socketFile)) {
      console.log("   Daemon socket ready\n");
    } else {
      console.log("   ⚠️  Daemon socket did not appear within 15s — continuing anyway\n");
    }
  } else {
    console.log("🔨 Starting local daemon...");

    // Source tree layout: cli/src/commands/ -> ../../.. -> repo root -> assistant/src/index.ts
    const sourceTreeIndex = join(import.meta.dir, "..", "..", "..", "assistant", "src", "index.ts");
    // bunx layout: @vellumai/cli/src/commands/ -> ../../../.. -> node_modules/ -> vellum/src/index.ts
    const bunxIndex = join(import.meta.dir, "..", "..", "..", "..", "vellum", "src", "index.ts");
    let assistantIndex = sourceTreeIndex;

    if (!existsSync(assistantIndex)) {
      assistantIndex = bunxIndex;
    }

    if (!existsSync(assistantIndex)) {
      try {
        const vellumPkgPath = _require.resolve("vellum/package.json");
        assistantIndex = join(dirname(vellumPkgPath), "src", "index.ts");
      } catch {
        // resolve failed, will fall through to existsSync check below
      }
    }

    if (!existsSync(assistantIndex)) {
      throw new Error(
        "vellum-daemon binary not found and assistant source not available.\n" +
          "  Ensure the daemon binary is bundled alongside the CLI, or run from the source tree.",
      );
    }

    const child = spawn("bun", ["run", assistantIndex, "daemon", "start"], {
      stdio: "inherit",
      env: {
        ...process.env,
        RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
      },
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Daemon start exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }
}

export async function startGateway(): Promise<string> {
  const publicUrl = await discoverPublicUrl();
  if (publicUrl) {
    console.log(`   Public URL: ${publicUrl}`);
  }

  console.log("🌐 Starting gateway...");
  const gatewayDir = resolveGatewayDir();
  // Only auto-configure default routing when the workspace has exactly one
  // assistant.  In multi-assistant deployments, falling back to "default"
  // would silently deliver unmapped Telegram chats to whichever assistant was
  // most recently hatched — keep the "reject" policy instead.
  const assistants = loadAllAssistants();
  const isSingleAssistant = assistants.length === 1;

  const gatewayEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    GATEWAY_RUNTIME_PROXY_ENABLED: "true",
    GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "false",
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
  };

  if (process.env.GATEWAY_UNMAPPED_POLICY) {
    gatewayEnv.GATEWAY_UNMAPPED_POLICY = process.env.GATEWAY_UNMAPPED_POLICY;
  } else if (isSingleAssistant) {
    gatewayEnv.GATEWAY_UNMAPPED_POLICY = "default";
  }

  if (process.env.GATEWAY_DEFAULT_ASSISTANT_ID) {
    gatewayEnv.GATEWAY_DEFAULT_ASSISTANT_ID = process.env.GATEWAY_DEFAULT_ASSISTANT_ID;
  } else if (isSingleAssistant) {
    gatewayEnv.GATEWAY_DEFAULT_ASSISTANT_ID =
      assistants[0].assistantId || loadLatestAssistant()?.assistantId || "default";
  }
  const workspaceIngressPublicBaseUrl = readWorkspaceIngressPublicBaseUrl();
  const ingressPublicBaseUrl =
    workspaceIngressPublicBaseUrl
    ?? normalizeIngressUrl(process.env.INGRESS_PUBLIC_BASE_URL)
    ?? publicUrl;
  if (ingressPublicBaseUrl) {
    gatewayEnv.INGRESS_PUBLIC_BASE_URL = ingressPublicBaseUrl;
    console.log(`   Ingress URL: ${ingressPublicBaseUrl}`);
  }

  const gateway = spawn("bun", ["run", "src/index.ts"], {
    cwd: gatewayDir,
    detached: true,
    stdio: "ignore",
    env: gatewayEnv,
  });
  gateway.unref();

  if (gateway.pid) {
    const vellumDir = join(homedir(), ".vellum");
    writeFileSync(join(vellumDir, "gateway.pid"), String(gateway.pid), "utf-8");
  }

  console.log("✅ Gateway started\n");
  return publicUrl || `http://localhost:${GATEWAY_PORT}`;
}
