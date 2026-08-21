import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

import { GATEWAY_PORT } from "./constants.js";
import {
  clearIngressUrl,
  getDefaultWorkspaceDir,
  loadNgrokDomain,
  loadRawConfig,
  saveIngressUrl,
  saveNgrokDomain,
} from "./ingress-config.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

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
    const res = await loopbackSafeFetch(NGROK_API_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NgrokTunnelsResponse;
    return data.tunnels ?? [];
  } catch {
    return null;
  }
}

/** Whether a tunnel targets the given local port, under any addr spelling. */
function tunnelTargetsPort(tunnel: NgrokTunnel, targetPort: number): boolean {
  const targetAddrs = [
    `localhost:${targetPort}`,
    `127.0.0.1:${targetPort}`,
    `http://localhost:${targetPort}`,
    `http://127.0.0.1:${targetPort}`,
  ];
  return targetAddrs.includes(tunnel.config?.addr ?? "");
}

/** Pick the tunnel for the target port (and domain, when set), HTTPS first. */
function pickMatchingTunnel(
  tunnels: NgrokTunnel[],
  targetPort: number,
  domain?: string,
): string | null {
  const matches = tunnels.filter(
    (t) =>
      tunnelTargetsPort(t, targetPort) &&
      (!domain || urlMatchesDomain(t.public_url, domain)),
  );
  const httpsTunnel = matches.find((t) => t.public_url.startsWith("https://"));
  if (httpsTunnel) return httpsTunnel.public_url;
  return matches.find((t) => t.public_url)?.public_url ?? null;
}

/** Render listed tunnels as `url -> addr` pairs for mismatch diagnostics. */
function describeTunnels(tunnels: NgrokTunnel[]): string {
  return tunnels
    .map((t) => `${t.public_url} -> ${t.config?.addr ?? "unknown target"}`)
    .join(", ");
}

/** Diagnostic for a running ngrok agent whose tunnels all miss the target port. */
function staleAgentDiagnostic(tunnels: NgrokTunnel[], port: number): string {
  return `an ngrok agent is already running but tunnels a different local port (${describeTunnels(tunnels)}), not ${port}. It was likely started before the tunnel edge unification or by an external process.`;
}

/** Recovery copy for a saved domain whose reservation may have lapsed. */
function savedDomainRecoveryHint(domain: string): string {
  return `The saved ngrok domain '${domain}' (ingress.ngrok.domain in the workspace config) may no longer be reserved. Run \`vellum tunnel --provider ngrok --clear-domain\` to drop it and tunnel without one.`;
}

/** Whether a tunnel public URL's host equals the given reserved domain. */
function urlMatchesDomain(publicUrl: string, domain: string): boolean {
  try {
    return (
      new URL(publicUrl).hostname.toLowerCase() === domain.trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Start an ngrok process tunneling HTTP traffic to the given local port.
 *
 * When `logFilePath` is provided, stdout/stderr are redirected to that file
 * instead of being piped. This avoids keeping pipe handles open in the
 * parent process — which would either prevent the CLI from exiting (if
 * handles are left open) or send SIGPIPE to ngrok (if destroyed).
 *
 * When `domain` is set, the tunnel binds that reserved ngrok domain via
 * `--domain=<domain>`.
 *
 * Returns the spawned child process.
 */
export function startNgrokProcess(
  targetPort: number,
  logFilePath?: string,
  domain?: string,
): ChildProcess {
  let stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
  let fd: number | undefined;
  if (logFilePath) {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(logFilePath, "a");
    stdio = ["ignore", fd, fd];
  }

  // Explicit over a bare port, which ngrok expands to `localhost`, whose ::1
  // answer resolves first on macOS and races the edge's IPv4 bind.
  const args = ["http", `127.0.0.1:${targetPort}`, "--log=stdout"];
  if (domain) {
    args.push(`--domain=${domain}`);
  }

  const child = spawn("ngrok", args, {
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
 * Poll the ngrok local API until a tunnel appears for the target port (and
 * reserved domain, when one is requested), preferring HTTPS.
 * Returns the public URL, or throws if the timeout is exceeded.
 */
export async function waitForNgrokUrl(
  targetPort: number,
  domain?: string,
  timeoutMs: number = NGROK_POLL_TIMEOUT_MS,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tunnels = await queryNgrokTunnels();
    if (tunnels && tunnels.length > 0) {
      const url = pickMatchingTunnel(tunnels, targetPort, domain);
      if (url) return url;
    }
    await new Promise((r) => setTimeout(r, NGROK_POLL_INTERVAL_MS));
  }
  throw new Error(
    `ngrok tunnel did not become available within ${timeoutMs / 1000}s. Check ngrok logs for errors.`,
  );
}

/**
 * Check whether an already-loaded workspace config has webhook-based
 * integrations (e.g. Telegram, Twilio) that require a public ingress URL.
 */
export function hasWebhookIntegrations(
  config: Record<string, unknown>,
): boolean {
  const telegram = config.telegram as Record<string, unknown> | undefined;
  if (telegram?.botUsername) return true;
  const twilio = config.twilio as Record<string, unknown> | undefined;
  if (twilio?.accountSid || twilio?.phoneNumber) return true;
  return false;
}

/**
 * Check whether the workspace at `workspaceDir` configures any webhook-based
 * integrations that require a public ingress URL. False when the config cannot
 * be read, so an unreadable workspace never blocks a caller.
 */
export function hasWebhookIntegrationsConfigured(
  workspaceDir: string,
): boolean {
  try {
    return hasWebhookIntegrations(loadRawConfig(workspaceDir));
  } catch {
    return false;
  }
}

/**
 * Check whether a non-ngrok ingress URL is already configured (e.g. custom
 * domain or cloud deployment), meaning ngrok is not needed.
 */
function hasNonNgrokIngressUrl(workspaceDir: string): boolean {
  try {
    const config = loadRawConfig(workspaceDir);
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
 * `assistantId` records what the tunnel fronts. Without it, an automatic start
 * would leave `ingress.assistantId` absent or stale from an earlier run.
 *
 * Returns the spawned ngrok child process (for PID tracking) or null.
 */
export async function maybeStartNgrokTunnel(
  targetPort: number,
  workspaceDir: string,
  assistantId?: string,
): Promise<ChildProcess | null> {
  // Managed/containerized deployments route webhooks through the platform's
  // callback proxy. ngrok is not needed and would not be reachable from the
  // platform anyway — skip it entirely.
  const isContainerized =
    process.env.IS_CONTAINERIZED === "true" ||
    process.env.IS_CONTAINERIZED === "1";
  if (isContainerized) return null;
  if (!hasWebhookIntegrationsConfigured(workspaceDir)) return null;
  if (hasNonNgrokIngressUrl(workspaceDir)) return null;

  const version = getNgrokVersion();
  if (!version) return null;

  const savedDomain = loadNgrokDomain(workspaceDir) ?? undefined;

  // Reuse an existing tunnel if one is already running
  const runningTunnels = (await queryNgrokTunnels()) ?? [];
  const existingUrl = pickMatchingTunnel(runningTunnels, targetPort);
  if (existingUrl) {
    if (savedDomain && !urlMatchesDomain(existingUrl, savedDomain)) {
      // Spawning a second agent would collide (ERR_NGROK_334), and saving the
      // mismatched URL would clobber the reserved-domain intent. Leave the
      // tunnel running but refuse to bless it in config.
      console.warn(
        `   ⚠ Existing ngrok tunnel ${existingUrl} does not match the reserved domain '${savedDomain}'. Ignoring it. Stop the running ngrok agent and run \`vellum tunnel --provider ngrok --domain ${savedDomain}\` to bind the reserved domain.`,
      );
      return null;
    }
    console.log(`   Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl, assistantId, "ngrok");
    return null;
  }
  if (runningTunnels.length > 0) {
    // An agent is up but tunnels some other local port (likely started before
    // the edge unification, or by an external process). Spawning a second
    // agent would collide (ERR_NGROK_334) on single-agent plans, so skip.
    console.warn(
      `   ⚠ ${staleAgentDiagnostic(runningTunnels, targetPort)} Stop that ngrok agent, then run \`vellum tunnel --provider ngrok\` to tunnel the local edge.`,
    );
    return null;
  }

  console.log(`   Starting ngrok tunnel for webhook integrations...`);

  // Spawn ngrok with stdout/stderr redirected to a log file instead of pipes.
  // This avoids two problems that occur with piped stdio:
  //   1. If pipe handles are left open, the CLI process hangs after hatch/wake.
  //   2. If pipe handles are destroyed, SIGPIPE kills ngrok on its next write.
  // Writing to a log file sidesteps both issues — the file descriptor is
  // inherited by the detached ngrok process and remains valid after CLI exit.
  const ngrokLogPath = join(workspaceDir, "data", "logs", "ngrok.log");
  const ngrokProcess = startNgrokProcess(targetPort, ngrokLogPath, savedDomain);
  ngrokProcess.unref();

  try {
    const publicUrl = await waitForNgrokUrl(targetPort, savedDomain);
    saveIngressUrl(workspaceDir, publicUrl, assistantId, "ngrok");
    console.log(`   Tunnel established: ${publicUrl}`);

    return ngrokProcess;
  } catch {
    console.warn(
      `   ⚠ Could not start ngrok tunnel. Webhook integrations may not work until you run \`vellum tunnel --provider ngrok\`.`,
    );
    if (savedDomain) {
      console.warn(`   ⚠ ${savedDomainRecoveryHint(savedDomain)}`);
    }
    if (!ngrokProcess.killed) ngrokProcess.kill("SIGTERM");
    return null;
  }
}

export interface RunNgrokTunnelOptions {
  /** Local edge port to forward. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Workspace directory for config read/write. Defaults to ~/.vellum/workspace. */
  workspaceDir?: string;
  /** Lockfile entry to mirror the ingress URL onto (`ingressUrl`). */
  assistantId?: string;
  /**
   * Reserved ngrok domain to bind. Persisted so wake restores reuse it.
   * When omitted, a previously saved domain is reused without being rewritten.
   */
  domain?: string;
}

/**
 * Run the ngrok tunnel workflow: check installation, find or start a tunnel,
 * save the public URL to config, and block until exit or signal.
 */
export async function runNgrokTunnel(
  opts: RunNgrokTunnelOptions = {},
): Promise<void> {
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

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const port = opts.port ?? GATEWAY_PORT;

  // The saved domain is standing intent: a run without --domain reuses it,
  // and only an explicit --domain rewrites it.
  const domain = opts.domain ?? loadNgrokDomain(workspaceDir) ?? undefined;
  if (domain && !opts.domain) {
    console.log(`Using saved ngrok domain: ${domain}`);
  }

  // Check for an existing ngrok tunnel pointing at the local edge
  const runningTunnels = (await queryNgrokTunnels()) ?? [];
  const existingUrl = pickMatchingTunnel(runningTunnels, port);
  if (!existingUrl && runningTunnels.length > 0) {
    // Spawning a second agent would collide (ERR_NGROK_334) on single-agent
    // plans; fail loudly instead, matching the domain-mismatch path.
    console.error(`Error: ${staleAgentDiagnostic(runningTunnels, port)}`);
    console.error(
      "Stop the existing ngrok agent first, then re-run this command to tunnel the local edge.",
    );
    process.exit(1);
  }
  if (existingUrl) {
    if (domain && !urlMatchesDomain(existingUrl, domain)) {
      console.error(
        `Error: an ngrok tunnel is already running on port ${port} at ${existingUrl}, which does not match the ${opts.domain ? "requested" : "saved"} domain '${domain}'.`,
      );
      console.error(
        "Stop the existing ngrok agent first, then re-run this command to bind the reserved domain.",
      );
      process.exit(1);
    }
    console.log(`Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl, opts.assistantId, "ngrok");
    if (opts.domain) {
      saveNgrokDomain(workspaceDir, opts.domain);
    }
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

  const ngrokProcess = startNgrokProcess(port, undefined, domain);

  const cleanup = () => {
    if (!ngrokProcess.killed) {
      ngrokProcess.kill("SIGTERM");
    }
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl(workspaceDir, opts.assistantId);
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
    publicUrl = await waitForNgrokUrl(port, domain);
  } catch (err) {
    cleanup();
    if (domain && !opts.domain) {
      console.error(savedDomainRecoveryHint(domain));
    }
    throw err;
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Forwarding to:     localhost:${port}`);

  // The domain is standing intent, not tunnel state: cleanup clears the
  // ingress URL but leaves the domain saved for wake/daemon restores.
  saveIngressUrl(workspaceDir, publicUrl, opts.assistantId, "ngrok");
  if (opts.domain) {
    saveNgrokDomain(workspaceDir, opts.domain);
  }
  console.log("Ingress URL saved to config.");
  console.log("");
  console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

  // Keep running until the ngrok process exits or we receive a signal
  await new Promise<void>((resolve) => {
    ngrokProcess.on("exit", () => resolve());
  });
}
