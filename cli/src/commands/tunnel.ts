import { readFileSync } from "node:fs";
import { join } from "path";

import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@vellumai/service-contracts/ingress";

import {
  formatAssistantReference,
  loadAllAssistants,
  resolveTargetAssistant,
  type AssistantEntry,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { runCloudflareTunnel } from "../lib/cloudflare-tunnel.js";
import { relaunchDetached } from "../lib/detached-process.js";
import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  parseGatewayPortFromEntryUrls,
  saveNgrokDomain,
} from "../lib/ingress-config.js";
import {
  ensureTunnelEdge,
  formatEdgeMode,
  type TunnelEdge,
} from "../lib/nginx-ingress.js";
import { hasWebhookIntegrationsConfigured, runNgrokTunnel } from "../lib/ngrok";
import { shellArg } from "../lib/shell-arg.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import { runTailscaleTunnel } from "../lib/tailscale-tunnel.js";

// `vellum` is the managed option this command owns; the local providers come
// from the shared registry so validation here cannot drift from what the
// workspace config accepts.
const VALID_PROVIDERS = ["vellum", ...TUNNEL_PROVIDERS] as const;
type TunnelProvider = (typeof VALID_PROVIDERS)[number];

// How far each provider's URL reaches, for the chooser a missing `--provider`
// prints. Keyed off the registry so a new provider cannot ship unoffered.
const PROVIDER_REACH: Record<TunnelProviderName, string> = {
  ngrok: "Public tunnel that webhook integrations can reach",
  cloudflare: "Public tunnel that webhook integrations can reach",
  tailscale: "Tailnet-only tunnel, reachable from your own devices",
};

interface TunnelArgs {
  assistantName: string | null;
  provider: TunnelProvider;
  domain: string | null;
  clearDomain: boolean;
  detach: boolean;
}

const FLAGS_WITH_VALUES = ["--provider", "--domain"] as const;

function parseArgs(): TunnelArgs {
  const args = process.argv.slice(3);
  let provider: TunnelProvider | null = null;
  let domain: string | null = null;
  let clearDomain = false;
  let detach = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: vellum tunnel [<name>] --provider <provider> [options]",
      );
      console.log("");
      console.log("Front a locally running assistant with an HTTPS tunnel.");
      console.log(
        "The tunnel URL is saved to the workspace config as the ingress base URL.",
      );
      console.log("");
      console.log(
        "How far that URL reaches depends on the provider, so --provider is required.",
      );
      console.log(
        "A tailscale tunnel is reachable only from your own tailnet; webhook",
      );
      console.log(
        "integrations need a public tunnel: --provider ngrok or --provider cloudflare.",
      );
      console.log("");
      console.log(
        "The tunnel always fronts the local nginx edge, which is started automatically.",
      );
      console.log(
        "nginx must be installed (macOS: brew install nginx, Linux: sudo apt install nginx).",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>                        Name of the assistant (defaults to active or only local)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        `  --provider <provider>         Required. Tunnel provider: ${VALID_PROVIDERS.join(", ")}`,
      );
      console.log(
        "  --domain <domain>             Reserved ngrok domain to bind (ngrok provider only).",
      );
      console.log(
        "                                Saved to the workspace config so `vellum wake` restores reuse it.",
      );
      console.log(
        "  --clear-domain                Clear the saved ngrok domain (ngrok provider only) and tunnel",
      );
      console.log(
        "                                without one. Cannot be combined with --domain.",
      );
      console.log(
        `  -d, --detach                  Run the tunnel in the background. Waits up to ${TUNNEL_BACKGROUND_START_TIMEOUT_MS / 1000}s for the`,
      );
      console.log(
        "                                initial established/failed status before returning; logs go to",
      );
      console.log(
        "                                the CLI log directory. Stop it with `kill <pid>`, except when it",
      );
      console.log(
        "                                adopted an already-running ngrok tunnel (started outside this",
      );
      console.log(
        "                                command): killing the supervisor then leaves that tunnel running.",
      );
      console.log("");
      console.log("Providers:");
      console.log(
        "  vellum       Managed tunnel via Vellum Cloud (not yet available)",
      );
      console.log(
        "  ngrok        ngrok tunnel — install: brew install ngrok/ngrok/ngrok",
      );
      console.log(
        "  cloudflare   Cloudflare quick tunnel — install: brew install cloudflare/cloudflare/cloudflared",
      );
      console.log(
        "               No Cloudflare account required for quick tunnels.",
      );
      console.log(
        "  tailscale    Tailscale serve. Install: https://tailscale.com/download, then run `tailscale up`",
      );
      console.log(
        "               Reachable only from your own tailnet (private; LetsEncrypt cert).",
      );
      console.log(
        "               When webhook integrations are configured it records its URL for device",
      );
      console.log(
        "               pairing only, leaving the saved webhook callback base as it is.",
      );
      console.log("");
      console.log("Examples:");
      console.log("  $ vellum tunnel --provider ngrok");
      console.log(
        "  $ vellum tunnel --provider ngrok --domain my-assistant.ngrok.app",
      );
      console.log("  $ vellum tunnel --provider ngrok --clear-domain");
      console.log("  $ vellum tunnel --provider cloudflare");
      console.log("  $ vellum tunnel my-assistant --provider tailscale");
      console.log("  $ vellum tunnel --provider ngrok --detach");
      process.exit(0);
    } else if (arg === "--provider") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(
          `Error: --provider requires one of: ${VALID_PROVIDERS.join(", ")}`,
        );
        process.exit(1);
      }
      if (!VALID_PROVIDERS.includes(next as TunnelProvider)) {
        console.error(
          `Error: unknown tunnel provider '${next}'. Valid providers: ${VALID_PROVIDERS.join(", ")}.`,
        );
        console.error(
          `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
        );
        process.exit(1);
      }
      provider = next as TunnelProvider;
      i++;
    } else if (arg === "--domain") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(
          "Error: --domain requires a value, e.g. --domain my-assistant.ngrok.app",
        );
        process.exit(1);
      }
      domain = next;
      i++;
    } else if (arg === "--clear-domain") {
      clearDomain = true;
    } else if (arg === "-d" || arg === "--detach") {
      detach = true;
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    }
  }

  // Joins all positionals so unquoted multi-word display names resolve as one
  // identifier (cli/AGENTS.md "Assistant targeting convention").
  const assistantName =
    parseAssistantTargetArg(args, FLAGS_WITH_VALUES) ?? null;

  if (provider === null) {
    console.error(
      "Error: --provider is required. How far the tunnel URL reaches depends on it, so there is no default.",
    );
    console.error("");
    console.error("Run one of:");
    // Carries the assistant through: dropping it would suggest a command that
    // tunnels the active assistant instead of the one that was asked for.
    const target = assistantName ? ` ${shellArg(assistantName)}` : "";
    for (const name of TUNNEL_PROVIDERS) {
      console.error(
        `  vellum tunnel${target} --provider ${name.padEnd(13)}${PROVIDER_REACH[name]}`,
      );
    }
    process.exit(1);
  }

  if (domain && provider !== "ngrok") {
    console.error(
      `Error: --domain is only supported with --provider ngrok (got '${provider}').`,
    );
    process.exit(1);
  }

  if (clearDomain && provider !== "ngrok") {
    console.error(
      `Error: --clear-domain is only supported with --provider ngrok (got '${provider}').`,
    );
    process.exit(1);
  }

  if (clearDomain && domain) {
    console.error(
      "Error: --clear-domain cannot be combined with --domain. Pass --domain alone to replace the saved domain.",
    );
    process.exit(1);
  }

  return { assistantName, provider, domain, clearDomain, detach };
}

/** A tunnelable assistant plus the gateway port and workspace the edge fronts. */
interface LocalTunnelTarget {
  entry: AssistantEntry;
  gatewayPort: number;
  workspaceDir: string;
}

/**
 * Map an entry to its local tunnel target, or null when it has no locally
 * reachable gateway (e.g. platform-hosted). Entries with `resources` carry
 * their own gateway port and instance workspace. Local container entries
 * (docker, apple-container) run locally without host resources: their gateway
 * port comes from localUrl/runtimeUrl and their ingress state lives in the
 * default workspace.
 */
function toLocalTunnelTarget(entry: AssistantEntry): LocalTunnelTarget | null {
  if (entry.resources) {
    return {
      entry,
      gatewayPort: entry.resources.gatewayPort,
      workspaceDir: join(entry.resources.instanceDir, ".vellum", "workspace"),
    };
  }
  if (isLocalContainerEntry(entry)) {
    const gatewayPort = parseGatewayPortFromEntryUrls(entry);
    if (gatewayPort !== undefined) {
      return { entry, gatewayPort, workspaceDir: getDefaultWorkspaceDir() };
    }
  }
  return null;
}

function describeUntunnelableEntry(entry: AssistantEntry): string {
  const reference = formatAssistantReference(entry);
  return entry.cloud === "vellum"
    ? `Assistant '${reference}' runs on Vellum Cloud and needs no tunnel.`
    : `Assistant '${reference}' has no locally managed runtime to tunnel.`;
}

/**
 * Resolve the assistant whose gateway and workspace the tunnel edge fronts.
 * Tunnels only make sense for assistants with a local gateway; when the
 * resolved entry has none (e.g. the active assistant is platform-hosted) and
 * no name was given, fall back to the sole local target, otherwise exit with
 * an error naming the local assistants to pass explicitly.
 */
function resolveLocalTunnelTarget(
  assistantName: string | null,
): LocalTunnelTarget {
  const entry = resolveTargetAssistant(assistantName ?? undefined);

  const target = toLocalTunnelTarget(entry);
  if (target) {
    return target;
  }

  const localTargets = loadAllAssistants()
    .map(toLocalTunnelTarget)
    .filter((local): local is LocalTunnelTarget => local !== null);

  if (!assistantName && localTargets.length === 1) {
    console.log(
      `${describeUntunnelableEntry(entry)} Tunneling the local assistant '${formatAssistantReference(localTargets[0].entry)}' instead.`,
    );
    return localTargets[0];
  }

  console.error(describeUntunnelableEntry(entry));
  if (localTargets.length === 0) {
    console.error(
      "No local assistant found to tunnel. Run `vellum hatch` first.",
    );
  } else {
    console.error(
      `Pass a local assistant as the name argument: ${localTargets
        .map((local) => formatAssistantReference(local.entry))
        .join(", ")}.`,
    );
  }
  process.exit(1);
}

/**
 * Decide how the tailnet-only tailscale tunnel may treat the saved ingress base
 * URL, which is also the webhook callback base. Returns true when the run must
 * leave that URL in place and record the tailnet address for pairing only.
 *
 * A tailnet address in the callback base would repoint those callbacks at
 * something external services cannot resolve, so no run replaces it while
 * webhook integrations are configured. The choice of tailscale is always the
 * user's own, so it is honored, with what it does and does not record spelled
 * out.
 */
function guardTailnetOnlyWebhookIngress(workspaceDir: string): boolean {
  if (!hasWebhookIntegrationsConfigured(workspaceDir)) {
    return false;
  }
  console.warn(
    "⚠ Webhook integrations are configured, and the tailscale tunnel is reachable only from your own tailnet, " +
      "so it cannot serve their callbacks. The saved ingress base URL stays as it is and the tailnet URL is " +
      "recorded for device pairing only. For a tunnel those integrations can reach too, use --provider ngrok " +
      "or --provider cloudflare.",
  );
  return true;
}

// Generous cap so a slow provider handshake (e.g. cloudflared's own ~30s
// quick-tunnel timeout) still counts as a successful, if slow, start.
const TUNNEL_BACKGROUND_START_TIMEOUT_MS = 35_000;
// Matches the "just established" line every provider prints, or ngrok's
// "found an already-running agent" adoption line (captured separately since
// that case does not own the tunnel it adopted).
const TUNNEL_ESTABLISHED_RE = /Tunnel established: (\S+)/;
const TUNNEL_ADOPTED_RE = /Found existing ngrok tunnel: (\S+)/;

/**
 * Re-invoke `vellum tunnel` (without `-d`/`--detach`) as a detached background
 * process via `relaunchDetached`, waiting for the child to either print its
 * "Tunnel established"/"Found existing ngrok tunnel" line (readiness) or
 * exit early (failure), so a misconfigured provider still fails loudly in
 * the terminal that ran `-d`.
 *
 * The log filename is scoped to this (parent) process's pid so concurrent
 * `-d` runs (e.g. tunneling two different local assistants at once) don't
 * truncate and read each other's readiness output.
 */
async function spawnDetachedTunnel(): Promise<void> {
  const childArgs: string[] = ["tunnel"];
  for (const arg of process.argv.slice(3)) {
    if (arg === "-d" || arg === "--detach") {
      continue;
    }
    childArgs.push(arg);
  }

  let publicUrl: string | undefined;
  let adopted = false;

  const { child, logPath, ready, exitCode } = await relaunchDetached({
    args: childArgs,
    logFile: `tunnel-${process.pid}.log`,
    timeoutMs: TUNNEL_BACKGROUND_START_TIMEOUT_MS,
    isReady: (logPath) => {
      let logText = "";
      try {
        logText = readFileSync(logPath, "utf-8");
      } catch {
        // Log file not written yet. Keep polling.
      }
      const established = TUNNEL_ESTABLISHED_RE.exec(logText);
      if (established) {
        publicUrl = established[1];
        return true;
      }
      const adoptedMatch = TUNNEL_ADOPTED_RE.exec(logText);
      if (adoptedMatch) {
        publicUrl = adoptedMatch[1];
        adopted = true;
        return true;
      }
      return false;
    },
  });

  if (exitCode !== undefined) {
    console.error(
      `Error: tunnel process exited during startup${exitCode !== null ? ` (exit code ${exitCode})` : ""}. Logs: ${logPath}`,
    );
    process.exit(1);
  }

  if (!ready) {
    console.log(
      `Tunnel is still starting up after ${TUNNEL_BACKGROUND_START_TIMEOUT_MS / 1000}s. Check progress: ${logPath}`,
    );
  } else if (publicUrl) {
    console.log(`Tunnel established: ${publicUrl}`);
  }
  console.log(`Running in background (pid ${child.pid}). Logs: ${logPath}`);
  if (adopted) {
    console.log(
      `That ngrok agent was already running outside this command, so \`kill ${child.pid}\` only ` +
        "stops this supervisor, not the ngrok tunnel or its saved ingress URL. Stop the ngrok agent " +
        "directly to end the tunnel.",
    );
  } else {
    console.log(`Stop with: kill ${child.pid}`);
  }
}

export async function tunnel(): Promise<void> {
  const { assistantName, provider, domain, clearDomain, detach } = parseArgs();

  if (detach) {
    await spawnDetachedTunnel();
    return;
  }

  if (provider === "vellum") {
    throw new Error(
      `Tunnel provider '${provider}' is not yet implemented. ` +
        `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
    );
  }

  const { entry, gatewayPort, workspaceDir } =
    resolveLocalTunnelTarget(assistantName);

  const preserveIngressUrl =
    provider === "tailscale" && guardTailnetOnlyWebhookIngress(workspaceDir);

  if (clearDomain) {
    saveNgrokDomain(workspaceDir, null);
    console.log("Cleared the saved ngrok domain from the workspace config.");
  }

  let edge: TunnelEdge;
  try {
    edge = await ensureTunnelEdge({
      assistantId: entry.assistantId,
      workspaceDir,
      gatewayPort,
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    `${edge.started ? "Started" : "Reusing"} the nginx edge on 127.0.0.1:${edge.port} ` +
      `(serves ${formatEdgeMode(edge.includesWebApp)}).`,
  );

  const baseTunnelOpts = {
    port: edge.port,
    assistantId: entry.assistantId,
    workspaceDir,
  };

  if (provider === "ngrok") {
    await runNgrokTunnel({
      ...baseTunnelOpts,
      ...(domain ? { domain } : {}),
    });
    return;
  }

  if (provider === "cloudflare") {
    await runCloudflareTunnel(baseTunnelOpts);
    return;
  }

  await runTailscaleTunnel({
    ...baseTunnelOpts,
    ...(preserveIngressUrl ? { preserveIngressUrl } : {}),
  });
}
