import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { GATEWAY_PORT } from "./constants";

const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 15_000;

interface NgrokTunnel {
  public_url: string;
  config?: { addr?: string };
}

interface NgrokTunnelsResponse {
  tunnels: NgrokTunnel[];
}

/**
 * Check whether ngrok is installed and accessible on the PATH.
 * Returns the version string if installed, null otherwise.
 */
export function getNgrokVersion(): string | null {
  try {
    const output = execFileSync("ngrok", ["version"], {
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
 * Query the ngrok local API for running tunnels.
 * Returns the list of tunnels, or null if the API is unreachable.
 */
async function queryNgrokTunnels(): Promise<NgrokTunnel[] | null> {
  try {
    const res = await fetch(NGROK_API_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NgrokTunnelsResponse;
    return data.tunnels ?? [];
  } catch {
    return null;
  }
}

/**
 * Find an existing ngrok tunnel that targets the given local address.
 * Returns the HTTPS public URL if found, null otherwise.
 */
export async function findExistingTunnel(
  targetPort: number,
): Promise<string | null> {
  const tunnels = await queryNgrokTunnels();
  if (!tunnels || tunnels.length === 0) return null;

  const targetAddrs = [
    `localhost:${targetPort}`,
    `127.0.0.1:${targetPort}`,
    `http://localhost:${targetPort}`,
    `http://127.0.0.1:${targetPort}`,
  ];

  // Prefer HTTPS tunnel
  for (const t of tunnels) {
    const addr = t.config?.addr ?? "";
    if (targetAddrs.includes(addr) && t.public_url.startsWith("https://")) {
      return t.public_url;
    }
  }

  // Fall back to any tunnel pointing at the target
  for (const t of tunnels) {
    const addr = t.config?.addr ?? "";
    if (targetAddrs.includes(addr) && t.public_url) {
      return t.public_url;
    }
  }

  return null;
}

/**
 * Start an ngrok process tunneling HTTP traffic to the given local port.
 * Returns the spawned child process.
 */
export function startNgrokProcess(targetPort: number): ChildProcess {
  const child = spawn("ngrok", ["http", String(targetPort), "--log=stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

/**
 * Poll the ngrok local API until an HTTPS tunnel URL appears.
 * Returns the public URL, or throws if the timeout is exceeded.
 */
export async function waitForNgrokUrl(
  timeoutMs: number = NGROK_POLL_TIMEOUT_MS,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tunnels = await queryNgrokTunnels();
    if (tunnels && tunnels.length > 0) {
      // Prefer HTTPS
      const httpsTunnel = tunnels.find((t) =>
        t.public_url.startsWith("https://"),
      );
      if (httpsTunnel) return httpsTunnel.public_url;
      if (tunnels[0]?.public_url) return tunnels[0].public_url;
    }
    await new Promise((r) => setTimeout(r, NGROK_POLL_INTERVAL_MS));
  }
  throw new Error(
    `ngrok tunnel did not become available within ${timeoutMs / 1000}s. Check ngrok logs for errors.`,
  );
}

/**
 * Read the workspace config.json file.
 */
function getConfigPath(): string {
  const baseDir =
    process.env.BASE_DATA_DIR?.trim() || homedir();
  return join(baseDir, ".vellum", "workspace", "config.json");
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function saveRawConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Persist a public ingress URL to the workspace config and enable ingress.
 */
export function saveIngressUrl(publicUrl: string): void {
  const config = loadRawConfig();
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  config.ingress = ingress;
  saveRawConfig(config);
}

/**
 * Clear the ingress public base URL from the workspace config.
 */
export function clearIngressUrl(): void {
  const config = loadRawConfig();
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(config);
}

/**
 * Return the gateway port to tunnel to.
 */
export function getGatewayPort(): number {
  return GATEWAY_PORT;
}
