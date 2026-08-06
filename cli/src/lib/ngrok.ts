import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { GATEWAY_PORT } from "./constants.js";
import {
  clearIngressUrl,
  getDefaultWorkspaceDir,
  loadNgrokAgent,
  loadNgrokDomain,
  loadRawConfig,
  saveIngressUrl,
  saveNgrokAgent,
  saveNgrokDomain,
} from "./ingress-config.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import { isNgrokProcess, stopProcess } from "./process.js";

const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 15_000;

export interface NgrokTunnel {
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

/** Local API URL for an ngrok agent bound to a dedicated web-addr port. */
function ngrokApiUrl(webAddrPort: number): string {
  return `http://127.0.0.1:${webAddrPort}/api/tunnels`;
}

/** Bind to an OS-assigned loopback port, release it, and return its number. */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
        } else if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not determine a free loopback port"));
        }
      });
    });
  });
}

/**
 * Query an ngrok agent's local API for running tunnels.
 * Returns the list of tunnels, or null if the API is unreachable.
 */
async function queryNgrokTunnels(
  apiUrl: string = NGROK_API_URL,
): Promise<NgrokTunnel[] | null> {
  try {
    const res = await loopbackSafeFetch(apiUrl, {
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
 * Agents visible to the spawn preflight: the default :4040 agent (foreign or
 * legacy reuse, never ours to stop) and our previously spawned dedicated
 * agent at its persisted web-addr port. A persisted record whose API no
 * longer answers is stale (the agent died or was stopped), so it is cleared
 * and reported absent.
 */
interface PreflightAgents {
  /** Tunnels listed by the default :4040 agent. */
  defaultAgentTunnels: NgrokTunnel[];
  /** The persisted vellum-owned agent, when its API still answers. */
  dedicatedAgent: {
    webAddrPort: number;
    pid: number | null;
    tunnels: NgrokTunnel[];
  } | null;
}

async function queryPreflightAgents(
  workspaceDir: string,
): Promise<PreflightAgents> {
  const defaultAgentTunnels = (await queryNgrokTunnels()) ?? [];
  let dedicatedAgent: PreflightAgents["dedicatedAgent"] = null;
  const saved = loadNgrokAgent(workspaceDir);
  if (saved !== null) {
    const tunnels = await queryNgrokTunnels(ngrokApiUrl(saved.webAddrPort));
    if (tunnels === null) {
      saveNgrokAgent(workspaceDir, null);
    } else {
      dedicatedAgent = {
        webAddrPort: saved.webAddrPort,
        pid: saved.pid,
        tunnels,
      };
    }
  }
  return { defaultAgentTunnels, dedicatedAgent };
}

/**
 * Stop our persisted dedicated agent and clear its record. Called when the
 * agent no longer serves the requested target/domain: it is vellum-owned, so
 * it must be replaced rather than coexisted with, otherwise the recorded pid
 * handoff would orphan its tunnel at sleep. Foreign agents are never stopped.
 * A missing or reused pid skips the kill but still clears the record so the
 * caller spawns fresh. stopProcess escalates SIGTERM to SIGKILL, so the old
 * agent is gone (or unkillably dying) before the record is cleared and a
 * replacement spawns.
 */
async function stopDedicatedAgent(
  workspaceDir: string,
  agent: { webAddrPort: number; pid: number | null },
): Promise<void> {
  if (agent.pid !== null && isNgrokProcess(agent.pid)) {
    await stopProcess(agent.pid, "ngrok agent");
  }
  saveNgrokAgent(workspaceDir, null);
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
export function pickMatchingTunnel(
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

/**
 * How a running agent's tunnel list relates to the requested target port:
 * `reuse` when it already tunnels the port (and domain, when set), `coexist`
 * when it only serves other targets (e.g. a foreign agent on :4040), `none`
 * when no tunnels are listed.
 */
export function classifyExistingAgent(
  tunnels: NgrokTunnel[],
  targetPort: number,
  domain?: string,
): "reuse" | "coexist" | "none" {
  if (tunnels.length === 0) {
    return "none";
  }
  return pickMatchingTunnel(tunnels, targetPort, domain) ? "reuse" : "coexist";
}

/** Notice for a running agent that does not tunnel the target port. */
function coexistNotice(tunnels: NgrokTunnel[]): string {
  return `another ngrok agent is running (${describeTunnels(tunnels)}); starting a separate ngrok agent for the local edge.`;
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

/** Build the ngrok CLI argument list for an HTTP tunnel. */
export function buildNgrokArgs(
  targetPort: number,
  domain?: string,
  webAddrPort?: number,
): string[] {
  const args = ["http", String(targetPort), "--log=stdout"];
  if (domain) {
    args.push(`--domain=${domain}`);
  }
  if (webAddrPort !== undefined) {
    args.push(`--web-addr=127.0.0.1:${webAddrPort}`);
  }
  return args;
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
 * When `webAddrPort` is set, the agent's local web UI/API binds
 * `127.0.0.1:<webAddrPort>` instead of the default :4040, so this agent can
 * coexist with a foreign agent that already holds the default address.
 *
 * Returns the spawned child process.
 */
export function startNgrokProcess(
  targetPort: number,
  logFilePath?: string,
  domain?: string,
  webAddrPort?: number,
): ChildProcess {
  let stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
  let fd: number | undefined;
  if (logFilePath) {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(logFilePath, "a");
    stdio = ["ignore", fd, fd];
  }

  const child = spawn(
    "ngrok",
    buildNgrokArgs(targetPort, domain, webAddrPort),
    {
      detached: true,
      stdio,
    },
  );

  // The child process inherits a duplicate of the fd via dup2, so the
  // parent's copy is no longer needed. Close it to avoid leaking the
  // file descriptor for the lifetime of the parent process.
  if (fd !== undefined) {
    closeSync(fd);
  }

  return child;
}

/**
 * Poll an ngrok agent's local API until a tunnel appears for the target port
 * (and reserved domain, when one is requested), preferring HTTPS.
 * Returns the public URL, or throws if the timeout is exceeded.
 */
export async function waitForNgrokUrl(
  targetPort: number,
  domain?: string,
  apiUrl: string = NGROK_API_URL,
  timeoutMs: number = NGROK_POLL_TIMEOUT_MS,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tunnels = await queryNgrokTunnels(apiUrl);
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

/** What the spawn preflight found, shared by both tunnel entry points. */
interface NgrokPreflight {
  /** Tunnels from every visible agent, after any stale-agent stop. */
  runningTunnels: NgrokTunnel[];
  /** Reusable tunnel URL for the target port (and domain, when set). */
  existingUrl: string | null;
  /** Agents are running but only serve other targets or domains. */
  coexist: boolean;
}

/**
 * Shared spawn preflight: query the default :4040 agent and our persisted
 * dedicated agent, stop the dedicated agent when it no longer serves the
 * requested target or domain (so the pid recorded for sleep never orphans
 * its tunnel; foreign agents are never stopped), and pick a reusable tunnel,
 * preferring a domain match when a domain is set. `onStopStaleAgent` lets
 * each caller keep its own messaging for the stop.
 */
async function preflightNgrok(
  workspaceDir: string,
  targetPort: number,
  domain: string | undefined,
  onStopStaleAgent: () => void,
): Promise<NgrokPreflight> {
  const agents = await queryPreflightAgents(workspaceDir);
  let runningTunnels = [
    ...agents.defaultAgentTunnels,
    ...(agents.dedicatedAgent?.tunnels ?? []),
  ];

  if (
    agents.dedicatedAgent !== null &&
    pickMatchingTunnel(agents.dedicatedAgent.tunnels, targetPort, domain) ===
      null
  ) {
    onStopStaleAgent();
    await stopDedicatedAgent(workspaceDir, agents.dedicatedAgent);
    runningTunnels = agents.defaultAgentTunnels;
  }

  return {
    runningTunnels,
    existingUrl: pickMatchingTunnel(runningTunnels, targetPort, domain),
    coexist:
      classifyExistingAgent(runningTunnels, targetPort, domain) === "coexist",
  };
}

/**
 * Spawn our dedicated agent: pick a free web-addr port so its local API
 * stays separate from any other agent's, start ngrok, wait for the tunnel
 * on our own agent's API, and persist the ingress URL plus the agent record
 * so the next preflight can reuse or stop this agent. `configure` runs right
 * after the spawn, before the tunnel wait (unref, event handlers). On any
 * failure the spawned process is killed and the error rethrown; warn-vs-exit
 * policy stays with the caller.
 */
async function spawnDedicatedAgent(opts: {
  targetPort: number;
  workspaceDir: string;
  domain?: string;
  logFilePath?: string;
  assistantId?: string;
  configure?: (child: ChildProcess) => void;
}): Promise<{ ngrokProcess: ChildProcess; publicUrl: string }> {
  const webAddrPort = await pickFreeLoopbackPort();
  const ngrokProcess = startNgrokProcess(
    opts.targetPort,
    opts.logFilePath,
    opts.domain,
    webAddrPort,
  );
  opts.configure?.(ngrokProcess);

  try {
    const publicUrl = await waitForNgrokUrl(
      opts.targetPort,
      opts.domain,
      ngrokApiUrl(webAddrPort),
    );
    saveIngressUrl(opts.workspaceDir, publicUrl, opts.assistantId);
    saveNgrokAgent(opts.workspaceDir, {
      webAddrPort,
      pid: ngrokProcess.pid ?? null,
    });
    return { ngrokProcess, publicUrl };
  } catch (err) {
    if (!ngrokProcess.killed) {
      ngrokProcess.kill("SIGTERM");
    }
    throw err;
  }
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
 * Check whether any webhook-based integrations (e.g. Telegram, Twilio) are
 * configured that require a public ingress URL.
 */
function hasWebhookIntegrationsConfigured(workspaceDir: string): boolean {
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
 * Returns the spawned ngrok child process (for PID tracking) or null.
 */
export async function maybeStartNgrokTunnel(
  targetPort: number,
  workspaceDir: string,
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

  // Reuse an existing tunnel if one is already running, from the default
  // :4040 agent or our own previously spawned dedicated agent; a stale
  // dedicated agent is stopped before it can be replaced.
  const { runningTunnels, existingUrl, coexist } = await preflightNgrok(
    workspaceDir,
    targetPort,
    savedDomain,
    () =>
      console.log(
        `   Stopping the previously started ngrok agent; it no longer matches the requested target.`,
      ),
  );
  if (existingUrl) {
    console.log(`   Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl);
    return null;
  }
  if (coexist) {
    // An agent is up but only tunnels other local targets or domains (e.g. a
    // foreign agent holding :4040, or a same-port tunnel under another
    // domain). Spawn our own agent on a dedicated web-addr; a clash on the
    // same reserved domain still surfaces via ngrok's own ERR_NGROK_334 exit.
    console.warn(`   ⚠ ${coexistNotice(runningTunnels)}`);
  }

  console.log(`   Starting ngrok tunnel for webhook integrations...`);

  // Spawn ngrok with stdout/stderr redirected to a log file instead of pipes.
  // This avoids two problems that occur with piped stdio:
  //   1. If pipe handles are left open, the CLI process hangs after hatch/wake.
  //   2. If pipe handles are destroyed, SIGPIPE kills ngrok on its next write.
  // Writing to a log file sidesteps both issues: the file descriptor is
  // inherited by the detached ngrok process and remains valid after CLI exit.
  const ngrokLogPath = join(workspaceDir, "data", "logs", "ngrok.log");

  try {
    // The whole spawn sequence (including the loopback web-addr allocation)
    // lives inside this guarded path so any failure stays nonfatal.
    const { ngrokProcess, publicUrl } = await spawnDedicatedAgent({
      targetPort,
      workspaceDir,
      domain: savedDomain,
      logFilePath: ngrokLogPath,
      configure: (child) => child.unref(),
    });
    console.log(`   Tunnel established: ${publicUrl}`);

    return ngrokProcess;
  } catch {
    console.warn(
      `   ⚠ Could not start ngrok tunnel. Webhook integrations may not work until you run \`vellum tunnel --provider ngrok\`.`,
    );
    if (savedDomain) {
      console.warn(`   ⚠ ${savedDomainRecoveryHint(savedDomain)}`);
    }
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

  // Check for an existing ngrok tunnel pointing at the local edge, from the
  // default :4040 agent or our own previously spawned dedicated agent; a
  // stale dedicated agent is stopped before it can be replaced.
  const { runningTunnels, existingUrl, coexist } = await preflightNgrok(
    workspaceDir,
    port,
    domain,
    () =>
      console.log(
        "Stopping the previously started ngrok agent; it no longer matches the requested target.",
      ),
  );
  if (coexist) {
    // An agent is up but only tunnels other local targets or domains (e.g. a
    // foreign agent holding :4040, or a same-port tunnel under another
    // domain). Spawn our own agent on a dedicated web-addr; a clash on the
    // same reserved domain still surfaces via ngrok's own ERR_NGROK_334 exit.
    console.warn(`Warning: ${coexistNotice(runningTunnels)}`);
  }
  if (existingUrl) {
    console.log(`Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl, opts.assistantId);
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
  let ngrokProcess: ChildProcess | undefined;

  const cleanup = () => {
    if (ngrokProcess && !ngrokProcess.killed) {
      ngrokProcess.kill("SIGTERM");
    }
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl(workspaceDir, opts.assistantId);
      saveNgrokAgent(workspaceDir, null);
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

  const configure = (child: ChildProcess) => {
    ngrokProcess = child;

    child.on("error", (err: Error) => {
      console.error(`ngrok process error: ${err.message}`);
      process.exit(1);
    });

    child.on("exit", (code: number | null) => {
      if (code !== null && code !== 0) {
        console.error(`ngrok exited with code ${code}.`);
        console.error(
          "Check that ngrok is authenticated: ngrok config add-authtoken <token>",
        );
        process.exit(1);
      }
    });

    // Pipe ngrok stdout/stderr to console for visibility
    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[ngrok] ${line}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[ngrok] ${line}`);
    });
  };

  try {
    // The domain is standing intent, not tunnel state: cleanup clears the
    // ingress URL and the agent record but leaves the domain saved for
    // wake/daemon restores.
    ({ ngrokProcess, publicUrl } = await spawnDedicatedAgent({
      targetPort: port,
      workspaceDir,
      domain,
      assistantId: opts.assistantId,
      configure,
    }));
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

  if (opts.domain) {
    saveNgrokDomain(workspaceDir, opts.domain);
  }
  console.log("Ingress URL saved to config.");
  console.log("");
  console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

  // Keep running until the ngrok process exits or we receive a signal
  await new Promise<void>((resolve) => {
    ngrokProcess?.on("exit", () => resolve());
  });
}
