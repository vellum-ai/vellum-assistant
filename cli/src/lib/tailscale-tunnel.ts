import { spawnSync } from "node:child_process";

import { GATEWAY_PORT } from "./constants.js";
import {
  clearIngressUrl,
  getDefaultWorkspaceDir,
  saveIngressUrl,
} from "./ingress-config.js";
import { resolveTunnelTargetPort } from "./nginx-ingress.js";

// ── Tailscale CLI discovery + invocation ────────────────────────────────────

/**
 * Common macOS locations for the tailscale CLI when it is not on PATH: the
 * Homebrew bin and the CLI bundled inside the Mac App Store / standalone app.
 */
const TAILSCALE_FALLBACK_PATHS = [
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const TAILSCALE_NOT_INSTALLED_MESSAGE = [
  "Tailscale is not installed or could not be found.",
  "",
  "Install Tailscale:",
  "  macOS:  brew install tailscale   (or install the Tailscale app)",
  "  Linux:  https://tailscale.com/download/linux",
  "",
  "Then start it and sign in: `tailscale up`.",
].join("\n");

export interface TailscaleCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Injectable seam for the tailscale binary. The real implementation shells out
 * via spawnSync; tests provide a fake to exercise the success and error paths
 * without a real tailscale install.
 */
export interface TailscaleDeps {
  /** Locate the tailscale CLI; returns the invocable path, null if absent. */
  findBinary(): string | null;
  /** Run `<bin> <args>` synchronously (spawnSync semantics). */
  run(bin: string, args: string[]): TailscaleCommandResult;
}

function realFindBinary(): string | null {
  for (const candidate of ["tailscale", ...TAILSCALE_FALLBACK_PATHS]) {
    const res = spawnSync(candidate, ["version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!res.error && res.status === 0) {
      return candidate;
    }
  }
  return null;
}

function realRun(bin: string, args: string[]): TailscaleCommandResult {
  const res = spawnSync(bin, args, { encoding: "utf-8", timeout: 15_000 });
  if (res.error) {
    throw res.error;
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function realTailscaleDeps(): TailscaleDeps {
  return { findBinary: realFindBinary, run: realRun };
}

// ── Status parsing ──────────────────────────────────────────────────────────

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; Online?: boolean };
}

/** Trim the trailing dot tailscale appends to MagicDNS names. */
export function normalizeDnsName(dnsName: string): string {
  return dnsName.replace(/\.$/, "");
}

/**
 * Validate `tailscale status --json` output and return the MagicDNS hostname
 * (without trailing dot) this machine serves at. Throws a clear error when the
 * daemon is logged out or otherwise not ready to serve.
 */
export function resolveServeHostname(statusJson: string): string {
  let status: TailscaleStatus;
  try {
    status = JSON.parse(statusJson) as TailscaleStatus;
  } catch {
    throw new Error("Could not parse `tailscale status --json` output.");
  }

  const backendState = status.BackendState;
  if (backendState === "NeedsLogin" || backendState === "NoState") {
    throw new Error(
      "Tailscale is not logged in. Run `tailscale up` and try again.",
    );
  }
  if (backendState && backendState !== "Running") {
    throw new Error(
      `Tailscale is not ready (state: ${backendState}). ` +
        "Start Tailscale and run `tailscale up`, then try again.",
    );
  }

  const dnsName = status.Self?.DNSName;
  if (!dnsName) {
    throw new Error(
      "Could not determine this machine's Tailscale DNS name from `tailscale status`. " +
        "Ensure Tailscale is running and signed in (`tailscale up`).",
    );
  }
  return normalizeDnsName(dnsName);
}

function joinOutput(result: TailscaleCommandResult): string {
  return [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Compose an error for a failed `tailscale serve`, surfacing tailscale's own
 * guidance (it prints an enable URL when Serve/HTTPS certs are not enabled for
 * the tailnet) rather than swallowing it.
 */
function serveFailureMessage(result: TailscaleCommandResult): string {
  const detail = joinOutput(result);
  const base =
    "`tailscale serve` failed. This usually means HTTPS certificates or the " +
    "Serve feature are not enabled for your tailnet — follow the link below to " +
    "enable them, then retry.";
  return detail ? `${base}\n\n${detail}` : base;
}

/**
 * The ingress URL may only be cleared once the serve mapping is confirmed
 * stopped. tailscaled maintains the mapping independently of this process, so
 * a failed or errored stop leaves the URL live — clearing the config then
 * would strand webhook configuration while the endpoint still answers.
 */
export function shouldClearIngressUrl(
  result: TailscaleCommandResult | null,
): boolean {
  return result !== null && result.status === 0;
}

// ── Tailscale serve lifecycle ───────────────────────────────────────────────

export interface RunTailscaleTunnelOptions {
  /** Gateway port to serve. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Workspace directory for config read/write. Defaults to ~/.vellum/workspace. */
  workspaceDir?: string;
  /** Prefer nginx ingress over the gateway port when it is running. */
  preferNginxIngress?: boolean;
  /** Lockfile entry to mirror the ingress URL onto (`ingressUrl`). */
  assistantId?: string;
}

export interface TailscaleServeInfo {
  publicUrl: string;
  port: number;
  viaIngress: boolean;
  binary: string;
  workspaceDir: string;
}

/**
 * Preflight tailscale, front the local edge with `tailscale serve --bg`, and
 * persist the resulting tailnet URL as the ingress base URL.
 *
 * `serve --bg` registers the mapping in tailscaled and returns immediately;
 * there is no long-lived child process to supervise. Throws on any failure
 * (binary missing, logged out, serve not enabled) with actionable guidance.
 */
export async function startTailscaleServe(
  opts: RunTailscaleTunnelOptions = {},
  deps: TailscaleDeps = realTailscaleDeps(),
): Promise<TailscaleServeInfo> {
  const binary = deps.findBinary();
  if (!binary) {
    throw new Error(TAILSCALE_NOT_INSTALLED_MESSAGE);
  }

  const statusResult = deps.run(binary, ["status", "--json"]);
  if (statusResult.status !== 0 || !statusResult.stdout.trim()) {
    const detail = joinOutput(statusResult);
    throw new Error(
      "Could not query Tailscale — is the Tailscale app running? " +
        "Start Tailscale and run `tailscale up`, then try again." +
        (detail ? `\n\n${detail}` : ""),
    );
  }

  const hostname = resolveServeHostname(statusResult.stdout);
  const publicUrl = `https://${hostname}`;

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const gatewayPort = opts.port ?? GATEWAY_PORT;
  const { port, viaIngress } = resolveTunnelTargetPort(
    workspaceDir,
    gatewayPort,
    { preferNginxIngress: opts.preferNginxIngress === true },
  );

  const serveResult = deps.run(binary, ["serve", "--bg", String(port)]);
  if (serveResult.status !== 0) {
    throw new Error(serveFailureMessage(serveResult));
  }

  saveIngressUrl(workspaceDir, publicUrl, opts.assistantId);

  return { publicUrl, port, viaIngress, binary, workspaceDir };
}

/**
 * Turn off the HTTPS serve on 443 (the narrow form — leaves any other serve
 * config intact). Returns the command result so callers can report failures.
 */
export function stopTailscaleServe(
  binary: string,
  deps: TailscaleDeps = realTailscaleDeps(),
): TailscaleCommandResult {
  return deps.run(binary, ["serve", "--https=443", "off"]);
}

/**
 * Run the tailscale tunnel workflow: preflight, serve the local edge over the
 * tailnet, persist the URL, then hold until Ctrl+C to tear the serve down and
 * clear the ingress URL.
 *
 * The tailnet URL carries a real LetsEncrypt certificate but is reachable only
 * from devices signed in to the same tailnet — no public exposure.
 */
export async function runTailscaleTunnel(
  opts: RunTailscaleTunnelOptions = {},
): Promise<void> {
  const deps = realTailscaleDeps();

  console.log("Setting up tailscale serve...");
  const { publicUrl, port, viaIngress, binary, workspaceDir } =
    await startTailscaleServe(opts, deps);

  if (viaIngress) {
    console.log(`nginx ingress detected — serving it on 127.0.0.1:${port}.`);
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Serving:            localhost:${port}`);
  console.log("");
  console.log("Ingress URL saved to config.");
  console.log(
    "This URL is reachable only from devices signed in to your tailnet.",
  );
  console.log("");
  console.log(
    "The serve runs in the background (tailscaled) and persists after this",
  );
  console.log(
    "command exits. Press Ctrl+C to stop serving and clear the ingress URL,",
  );
  console.log("or stop it later with: tailscale serve --https=443 off");

  const teardown = (): void => {
    console.log("\nStopping tailscale serve and clearing the ingress URL...");
    let result: TailscaleCommandResult | null = null;
    try {
      result = stopTailscaleServe(binary, deps);
    } catch (err) {
      console.error(
        `Could not stop tailscale serve automatically (${
          err instanceof Error ? err.message : String(err)
        }). Run \`tailscale serve --https=443 off\` manually.`,
      );
    }
    if (result && result.status !== 0) {
      const detail = joinOutput(result);
      console.error(
        "Could not stop tailscale serve automatically. Run " +
          "`tailscale serve --https=443 off` manually." +
          (detail ? `\n${detail}` : ""),
      );
    }
    if (shouldClearIngressUrl(result)) {
      clearIngressUrl(workspaceDir, opts.assistantId);
    } else {
      console.error(
        "Keeping the saved ingress URL since serve may still be active. " +
          "After stopping serve manually, clear it with another Ctrl+C run " +
          "or by re-running the tunnel command.",
      );
    }
  };

  const shutdown = (): void => {
    teardown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Hold the process open until a signal fires. The serve itself lives in
  // tailscaled, so there is no child process to await — the registered signal
  // listeners keep the event loop alive.
  await new Promise<void>(() => {});
}
