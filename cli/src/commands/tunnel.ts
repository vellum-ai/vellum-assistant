import { join } from "path";

import {
  formatAssistantReference,
  loadAllAssistants,
  resolveTargetAssistant,
  type AssistantEntry,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { runCloudflareTunnel } from "../lib/cloudflare-tunnel.js";
import {
  getDefaultWorkspaceDir,
  saveNgrokDomain,
} from "../lib/ingress-config.js";
import {
  ensureTunnelEdge,
  formatEdgeMode,
  type TunnelEdge,
} from "../lib/nginx-ingress.js";
import { runNgrokTunnel } from "../lib/ngrok";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import { runTailscaleTunnel } from "../lib/tailscale-tunnel.js";
import { parseGatewayPortFromEntryUrls } from "./nginx-ingress.js";

const VALID_PROVIDERS = ["vellum", "ngrok", "cloudflare", "tailscale"] as const;
type TunnelProvider = (typeof VALID_PROVIDERS)[number];

const DEFAULT_PROVIDER: TunnelProvider = "vellum";

interface TunnelArgs {
  assistantName: string | null;
  provider: TunnelProvider;
  domain: string | null;
  clearDomain: boolean;
}

const FLAGS_WITH_VALUES = ["--provider", "--domain"] as const;

function parseArgs(): TunnelArgs {
  const args = process.argv.slice(3);
  let provider: TunnelProvider = DEFAULT_PROVIDER;
  let domain: string | null = null;
  let clearDomain = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum tunnel [<name>] [options]");
      console.log("");
      console.log(
        "Expose a locally running assistant to the internet via a tunnel.",
      );
      console.log(
        "The public URL is saved to the workspace config as the ingress base URL,",
      );
      console.log(
        "enabling webhook integrations (Telegram, Twilio, etc.) to reach the assistant.",
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
        `  --provider <provider>         Tunnel provider: ${VALID_PROVIDERS.join(", ")} (default: ${DEFAULT_PROVIDER})`,
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
      console.log("");
      console.log("Providers:");
      console.log(
        "  vellum       Managed tunnel via Vellum Cloud (default; requires account)",
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
        "  tailscale    Tailscale serve — install: brew install tailscale, then `tailscale up`",
      );
      console.log(
        "               Reachable only from your own tailnet (private; LetsEncrypt cert).",
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
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    }
  }

  // Joins all positionals so unquoted multi-word display names resolve as one
  // identifier (cli/AGENTS.md "Assistant targeting convention").
  const assistantName =
    parseAssistantTargetArg(args, FLAGS_WITH_VALUES) ?? null;

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

  return { assistantName, provider, domain, clearDomain };
}

/** A tunnelable assistant plus the gateway port and workspace the edge fronts. */
interface LocalTunnelTarget {
  entry: AssistantEntry;
  gatewayPort: number;
  workspaceDir: string;
}

/** Container topologies whose gateway runs on this machine without host `resources`. */
function isLocalContainerEntry(entry: AssistantEntry): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}

/**
 * Map an entry to its local tunnel target, or null when it has no locally
 * reachable gateway (e.g. platform-hosted). Entries with `resources` carry
 * their own gateway port and instance workspace. Local container entries
 * (docker, apple-container) run locally without host resources: their gateway
 * port comes from localUrl/runtimeUrl and their ingress state lives in the
 * default workspace, matching the `vellum nginx-ingress` resolution for the
 * same topology.
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

export async function tunnel(): Promise<void> {
  const { assistantName, provider, domain, clearDomain } = parseArgs();

  if (provider === "vellum") {
    throw new Error(
      `Tunnel provider '${provider}' is not yet implemented. ` +
        `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
    );
  }

  const { entry, gatewayPort, workspaceDir } =
    resolveLocalTunnelTarget(assistantName);

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

  await runTailscaleTunnel(baseTunnelOpts);
}
