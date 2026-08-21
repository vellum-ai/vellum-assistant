import { join } from "path";

import { TUNNEL_PROVIDERS } from "@vellumai/service-contracts/ingress";

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
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import { runTailscaleTunnel } from "../lib/tailscale-tunnel.js";

// `vellum` is the managed option this command owns; the local providers come
// from the shared registry so validation here cannot drift from what the
// workspace config accepts.
const VALID_PROVIDERS = ["vellum", ...TUNNEL_PROVIDERS] as const;
type TunnelProvider = (typeof VALID_PROVIDERS)[number];

const DEFAULT_PROVIDER: TunnelProvider = "tailscale";

interface TunnelArgs {
  assistantName: string | null;
  provider: TunnelProvider;
  /** True when `--provider` named the provider, so the tailnet-only default
   *  is a deliberate choice rather than one the user fell into. */
  providerExplicit: boolean;
  domain: string | null;
  clearDomain: boolean;
}

const FLAGS_WITH_VALUES = ["--provider", "--domain"] as const;

function parseArgs(): TunnelArgs {
  const args = process.argv.slice(3);
  let provider: TunnelProvider = DEFAULT_PROVIDER;
  let providerExplicit = false;
  let domain: string | null = null;
  let clearDomain = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum tunnel [<name>] [options]");
      console.log("");
      console.log("Front a locally running assistant with an HTTPS tunnel.");
      console.log(
        "The tunnel URL is saved to the workspace config as the ingress base URL.",
      );
      console.log("");
      console.log(
        "How far that URL reaches depends on the provider. The default tailscale",
      );
      console.log(
        "tunnel is reachable only from your own tailnet; webhook integrations need",
      );
      console.log(
        "a public tunnel: --provider ngrok or --provider cloudflare.",
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
        "  tailscale    Tailscale serve (default). Install: https://tailscale.com/download, then run `tailscale up`",
      );
      console.log(
        "               Reachable only from your own tailnet (private; LetsEncrypt cert).",
      );
      console.log(
        "               Must be named explicitly when webhook integrations are configured,",
      );
      console.log(
        "               and then records its URL for device pairing only, leaving the saved",
      );
      console.log("               webhook callback base as it is.");
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
      providerExplicit = true;
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

  return { assistantName, provider, providerExplicit, domain, clearDomain };
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
 * webhook integrations are configured. Falling into the tunnel by default is
 * refused outright, since the tunnel cannot carry those callbacks either; an
 * explicit choice is honored, with what it does and does not record spelled
 * out.
 */
function guardTailnetOnlyWebhookIngress(
  workspaceDir: string,
  providerExplicit: boolean,
): boolean {
  if (!hasWebhookIntegrationsConfigured(workspaceDir)) {
    return false;
  }
  if (providerExplicit) {
    console.warn(
      "⚠ Webhook integrations are configured, and the tailscale tunnel is reachable only from your own tailnet, " +
        "so it cannot serve their callbacks. The saved ingress base URL stays as it is and the tailnet URL is " +
        "recorded for device pairing only. For a tunnel those integrations can reach too, use --provider ngrok " +
        "or --provider cloudflare.",
    );
    return true;
  }
  console.error(
    "Error: webhook integrations are configured, and the default tailscale tunnel is reachable only from your own tailnet.",
  );
  console.error(
    "It cannot serve their callbacks, so falling into it by default would leave them without working ingress.",
  );
  console.error("");
  console.error("Run one of:");
  console.error(
    "  vellum tunnel --provider ngrok        Public tunnel that webhook integrations can reach",
  );
  console.error(
    "  vellum tunnel --provider cloudflare   Public tunnel that webhook integrations can reach",
  );
  console.error(
    "  vellum tunnel --provider tailscale    Tailnet-only tunnel for pairing; leaves the callback base alone",
  );
  process.exit(1);
}

export async function tunnel(): Promise<void> {
  const { assistantName, provider, providerExplicit, domain, clearDomain } =
    parseArgs();

  if (provider === "vellum") {
    throw new Error(
      `Tunnel provider '${provider}' is not yet implemented. ` +
        `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
    );
  }

  const { entry, gatewayPort, workspaceDir } =
    resolveLocalTunnelTarget(assistantName);

  const preserveIngressUrl =
    provider === "tailscale" &&
    guardTailnetOnlyWebhookIngress(workspaceDir, providerExplicit);

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
