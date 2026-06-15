import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { GATEWAY_PORT } from "./constants.js";
import { resolveTunnelTargetPort } from "./nginx-ingress.js";

// ── Workspace config helpers (mirrors the pattern in ngrok.ts) ───────────────

function getDefaultWorkspaceDir(): string {
  return (
    process.env.VELLUM_WORKSPACE_DIR?.trim() ||
    join(homedir(), ".vellum", "workspace")
  );
}

function getConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

function loadRawConfig(workspaceDir: string): Record<string, unknown> {
  const configPath = getConfigPath(workspaceDir);
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function saveRawConfig(
  workspaceDir: string,
  config: Record<string, unknown>,
): void {
  const configPath = getConfigPath(workspaceDir);
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function saveIngressUrl(workspaceDir: string, publicUrl: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

function clearIngressUrl(workspaceDir: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────

const CLOUDFLARED_TIMEOUT_MS = 30_000;

// Quick-tunnel hostnames follow the pattern <word>-<word>-<word>.trycloudflare.com
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Check whether cloudflared is installed and on PATH.
 * Returns the version string if found, null otherwise.
 */
export function getCloudflareTunnelVersion(): string | null {
  try {
    const output = execFileSync("cloudflared", ["version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Spawn a cloudflared quick-tunnel process forwarding HTTP traffic to
 * `targetPort`.  The child process writes its public URL to stderr during
 * startup — use {@link waitForCloudflareTunnelUrl} to extract it.
 */
export function startCloudflareTunnelProcess(targetPort: number): ChildProcess {
  return spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${targetPort}`, "--no-autoupdate"],
    // Keep stdio as pipes so we can parse the URL from output.
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * Listen to a running cloudflared process's stdout/stderr and resolve with
 * the public quick-tunnel URL once cloudflared prints it.
 *
 * cloudflared emits a line containing the trycloudflare.com URL during
 * startup — typically within 5–15 seconds on a normal internet connection.
 *
 * Rejects when:
 * - The URL does not appear within `timeoutMs`.
 * - The child process exits before the URL is found.
 */
export function waitForCloudflareTunnelUrl(
  child: ChildProcess,
  timeoutMs: number = CLOUDFLARED_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `cloudflared tunnel URL did not appear within ${timeoutMs / 1000}s. ` +
            `Ensure cloudflared is working: try running 'cloudflared tunnel --url http://localhost:7840' manually.`,
        ),
      );
    }, timeoutMs);

    let resolved = false;

    function scanLine(line: string): void {
      if (resolved) return;
      const match = QUICK_TUNNEL_URL_RE.exec(line);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    }

    // Buffer incomplete lines across chunks
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
    });

    child.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      reject(
        new Error(
          `cloudflared exited with code ${code ?? "unknown"} before the tunnel URL appeared.`,
        ),
      );
    });
  });
}

/**
 * Run the cloudflared quick-tunnel workflow:
 * 1. Verify cloudflared is installed.
 * 2. Start a quick tunnel pointing at the gateway port.
 * 3. Parse the public URL from cloudflared output.
 * 4. Persist the URL to the workspace config as the ingress base URL.
 * 5. Block until the process exits or the user presses Ctrl+C.
 * 6. Clear the ingress URL from config on exit.
 *
 * No Cloudflare account is required — quick tunnels are free and ephemeral.
 */
export interface RunCloudflareTunnelOptions {
  /** Gateway port to forward. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Workspace directory for config read/write. Defaults to ~/.vellum/workspace. */
  workspaceDir?: string;
  /** Prefer nginx ingress over the gateway port when it is running. */
  preferNginxIngress?: boolean;
}

export async function runCloudflareTunnel(
  opts: RunCloudflareTunnelOptions = {},
): Promise<void> {
  const version = getCloudflareTunnelVersion();
  if (!version) {
    console.error("Error: cloudflared is not installed.");
    console.error("");
    console.error("Install cloudflared:");
    console.error("  macOS:   brew install cloudflare/cloudflare/cloudflared");
    console.error("  Linux:   https://pkg.cloudflare.com/index.html");
    console.error(
      "  Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    );
    console.error("");
    console.error("No Cloudflare account is required for quick tunnels.");
    process.exit(1);
  }

  console.log(`Using ${version}`);

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const gatewayPort = opts.port ?? GATEWAY_PORT;
  const { port, viaIngress } = resolveTunnelTargetPort(
    workspaceDir,
    gatewayPort,
    { preferNginxIngress: opts.preferNginxIngress === true },
  );
  if (viaIngress) {
    console.log(
      `nginx ingress detected — tunneling to it on 127.0.0.1:${port}.`,
    );
  }

  console.log(`Starting cloudflared quick tunnel to localhost:${port}...`);
  console.log("No Cloudflare account required — quick tunnels are free.");
  console.log("");

  let publicUrl: string | undefined;
  const child = startCloudflareTunnelProcess(port);

  const cleanup = (): void => {
    if (!child.killed) child.kill("SIGTERM");
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl(workspaceDir);
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  child.on("error", (err: Error) => {
    console.error(`cloudflared process error: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    // Always clear the saved ingress URL when the tunnel process ends so
    // webhook integrations don't keep hitting a dead endpoint.
    if (publicUrl !== undefined) {
      clearIngressUrl(workspaceDir);
    }
    if (code !== null && code !== 0) {
      console.error(`\ncloudflared exited with code ${code}.`);
      process.exit(1);
    }
  });

  // Forward cloudflared output to the console so the user can see startup
  // progress and any authentication errors.
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });

  try {
    publicUrl = await waitForCloudflareTunnelUrl(child);
  } catch (err) {
    cleanup();
    throw err;
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Forwarding to:     localhost:${port}`);
  console.log("");

  saveIngressUrl(workspaceDir, publicUrl);
  console.log("Ingress URL saved to config.");
  console.log("");
  console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

  // Keep running until cloudflared exits (e.g., network error or user Ctrl+C)
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}
