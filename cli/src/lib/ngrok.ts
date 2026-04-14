import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getCurrentEnvironment, getDataDir } from "@vellumai/environments";

import { GATEWAY_PORT } from "./constants";

function getConfigPath(): string {
  return join(getDataDir(getCurrentEnvironment()), "workspace", "config.json");
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function saveRawConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

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
 *
 * When `logFilePath` is provided, stdout/stderr are redirected to that file
 * instead of being piped. This avoids keeping pipe handles open in the
 * parent process — which would either prevent the CLI from exiting (if
 * handles are left open) or send SIGPIPE to ngrok (if destroyed).
 *
 * Returns the spawned child process.
 */
export function startNgrokProcess(
  targetPort: number,
  logFilePath?: string,
): ChildProcess {
  let stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
  let fd: number | undefined;
  if (logFilePath) {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(logFilePath, "a");
    stdio = ["ignore", fd, fd];
  }

  const child = spawn("ngrok", ["http", String(targetPort), "--log=stdout"], {
    detached: true,
    stdio,
  });

  // The child process inherits a duplicate of the fd via dup2, so the
  // parent's copy is no longer needed. Close it to avoid leaking the
  // file descriptor for the lifetime of the parent process.
  if (fd !== undefined) {
    closeSync(fd);
  }

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
 * Persist a public ingress URL to the workspace config and enable ingress.
 */
function saveIngressUrl(publicUrl: string): void {
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
function clearIngressUrl(): void {
  const config = loadRawConfig();
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(config);
}

/**
 * Check whether any webhook-based integrations (e.g. Telegram, Twilio) are
 * configured that require a public ingress URL.
 */
function hasWebhookIntegrationsConfigured(): boolean {
  try {
    const config = loadRawConfig();
    const telegram = config.telegram as Record<string, unknown> | undefined;
    if (telegram?.botUsername) return true;
    const twilio = config.twilio as Record<string, unknown> | undefined;
    if (twilio?.accountSid || twilio?.phoneNumber) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Check whether a non-ngrok ingress URL is already configured (e.g. custom
 * domain or cloud deployment), meaning ngrok is not needed.
 */
function hasNonNgrokIngressUrl(): boolean {
  try {
    const config = loadRawConfig();
    const ingress = config.ingress as Record<string, unknown> | undefined;
    const publicBaseUrl = ingress?.publicBaseUrl;
    if (!publicBaseUrl || typeof publicBaseUrl !== "string") return false;
    return !publicBaseUrl.includes("ngrok");
  } catch {
    return false;
  }
}

/**
 * Auto-start an ngrok tunnel if webhook integrations are configured and no
 * non-ngrok ingress URL is present. Designed to be called during daemon/gateway
 * startup. Non-fatal: if ngrok is unavailable or fails, startup continues.
 *
 * Returns the spawned ngrok child process (for PID tracking) or null.
 */
export async function maybeStartNgrokTunnel(
  targetPort: number,
): Promise<ChildProcess | null> {
  // Managed/containerized deployments route webhooks through the platform's
  // callback proxy. ngrok is not needed and would not be reachable from the
  // platform anyway — skip it entirely.
  const isContainerized =
    process.env.IS_CONTAINERIZED === "true" ||
    process.env.IS_CONTAINERIZED === "1";
  if (isContainerized) return null;
  if (!hasWebhookIntegrationsConfigured()) return null;
  if (hasNonNgrokIngressUrl()) return null;

  const version = getNgrokVersion();
  if (!version) return null;

  // Reuse an existing tunnel if one is already running
  const existingUrl = await findExistingTunnel(targetPort);
  if (existingUrl) {
    console.log(`   Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(existingUrl);
    return null;
  }

  console.log(`   Starting ngrok tunnel for webhook integrations...`);

  // Spawn ngrok with stdout/stderr redirected to a log file instead of pipes.
  // This avoids two problems that occur with piped stdio:
  //   1. If pipe handles are left open, the CLI process hangs after hatch/wake.
  //   2. If pipe handles are destroyed, SIGPIPE kills ngrok on its next write.
  // Writing to a log file sidesteps both issues — the file descriptor is
  // inherited by the detached ngrok process and remains valid after CLI exit.
  const root = getDataDir(getCurrentEnvironment());
  const ngrokLogPath = join(root, "workspace", "data", "logs", "ngrok.log");
  const ngrokProcess = startNgrokProcess(targetPort, ngrokLogPath);
  ngrokProcess.unref();

  try {
    const publicUrl = await waitForNgrokUrl();
    saveIngressUrl(publicUrl);
    console.log(`   Tunnel established: ${publicUrl}`);

    return ngrokProcess;
  } catch {
    console.warn(
      `   ⚠ Could not start ngrok tunnel. Webhook integrations may not work until you run \`vellum tunnel\`.`,
    );
    if (!ngrokProcess.killed) ngrokProcess.kill("SIGTERM");
    return null;
  }
}

/**
 * Run the ngrok tunnel workflow: check installation, find or start a tunnel,
 * save the public URL to config, and block until exit or signal.
 */
export async function runNgrokTunnel(): Promise<void> {
  const version = getNgrokVersion();
  if (!version) {
    console.error("Error: ngrok is not installed.");
    console.error("");
    console.error("Install ngrok:");
    console.error("  macOS:  brew install ngrok/ngrok/ngrok");
    console.error("  Linux:  sudo snap install ngrok");
    console.error("");
    console.error("Then authenticate: ngrok config add-authtoken <your-token>");
    console.error(
      "  Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken",
    );
    process.exit(1);
  }

  console.log(`Using ${version}`);

  const port = GATEWAY_PORT;

  // Check for an existing ngrok tunnel pointing at the gateway
  const existingUrl = await findExistingTunnel(port);
  if (existingUrl) {
    console.log(`Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(existingUrl);
    console.log("Ingress URL saved to config.");
    console.log("");
    console.log(
      "Tunnel is already running. Press Ctrl+C to detach (tunnel stays active).",
    );

    // Block until SIGINT/SIGTERM
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    return;
  }

  console.log(`Starting ngrok tunnel to localhost:${port}...`);

  let publicUrl: string | undefined;

  const ngrokProcess = startNgrokProcess(port);

  const cleanup = () => {
    if (!ngrokProcess.killed) {
      ngrokProcess.kill("SIGTERM");
    }
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl();
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

  ngrokProcess.on("error", (err: Error) => {
    console.error(`ngrok process error: ${err.message}`);
    process.exit(1);
  });

  ngrokProcess.on("exit", (code: number | null) => {
    if (code !== null && code !== 0) {
      console.error(`ngrok exited with code ${code}.`);
      console.error(
        "Check that ngrok is authenticated: ngrok config add-authtoken <token>",
      );
      process.exit(1);
    }
  });

  // Pipe ngrok stdout/stderr to console for visibility
  ngrokProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[ngrok] ${line}`);
  });
  ngrokProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error(`[ngrok] ${line}`);
  });

  try {
    publicUrl = await waitForNgrokUrl();
  } catch (err) {
    cleanup();
    throw err;
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Forwarding to:     localhost:${port}`);

  saveIngressUrl(publicUrl);
  console.log("Ingress URL saved to config.");
  console.log("");
  console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

  // Keep running until the ngrok process exits or we receive a signal
  await new Promise<void>((resolve) => {
    ngrokProcess.on("exit", () => resolve());
  });
}
