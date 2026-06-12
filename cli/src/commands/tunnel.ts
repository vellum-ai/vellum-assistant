import { join } from "path";

import { resolveAssistant } from "../lib/assistant-config";
import { runCloudflareTunnel } from "../lib/cloudflare-tunnel.js";
import {
  isAssistantFeatureFlagEnabled,
  WEB_REMOTE_INGRESS_FLAG,
} from "../lib/feature-flags.js";
import { runNgrokTunnel } from "../lib/ngrok";

const VALID_PROVIDERS = ["vellum", "ngrok", "cloudflare", "tailscale"] as const;
type TunnelProvider = (typeof VALID_PROVIDERS)[number];

const DEFAULT_PROVIDER: TunnelProvider = "vellum";

interface TunnelArgs {
  assistantName: string | null;
  provider: TunnelProvider;
}

function parseArgs(): TunnelArgs {
  const args = process.argv.slice(3);
  let assistantName: string | null = null;
  let provider: TunnelProvider = DEFAULT_PROVIDER;

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
      console.log("Arguments:");
      console.log(
        "  <name>                        Name of the assistant (defaults to active or only local)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        `  --provider <provider>         Tunnel provider: ${VALID_PROVIDERS.join(", ")} (default: ${DEFAULT_PROVIDER})`,
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
      console.log("");
      console.log("Examples:");
      console.log("  $ vellum tunnel");
      console.log("  $ vellum tunnel --provider ngrok");
      console.log("  $ vellum tunnel --provider cloudflare");
      console.log("  $ vellum tunnel my-assistant --provider cloudflare");
      process.exit(0);
    } else if (arg === "--provider") {
      const next = args[i + 1];
      if (!next || !VALID_PROVIDERS.includes(next as TunnelProvider)) {
        console.error(
          `Error: --provider requires one of: ${VALID_PROVIDERS.join(", ")}`,
        );
        process.exit(1);
      }
      provider = next as TunnelProvider;
      i++;
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    } else if (!assistantName) {
      assistantName = arg;
    } else {
      console.error(`Error: Unexpected argument '${arg}'.`);
      process.exit(1);
    }
  }

  return { assistantName, provider };
}

async function shouldPreferNginxIngress(assistantId: string): Promise<boolean> {
  try {
    return await isAssistantFeatureFlagEnabled(
      assistantId,
      WEB_REMOTE_INGRESS_FLAG,
    );
  } catch (err) {
    throw new Error(
      `Could not verify the \`${WEB_REMOTE_INGRESS_FLAG}\` feature flag before starting the tunnel. Is the assistant running? Try \`vellum wake\` and retry. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function tunnel(): Promise<void> {
  const { assistantName, provider } = parseArgs();

  const entry = resolveAssistant(assistantName ?? undefined);

  if (!entry) {
    if (assistantName) {
      console.error(
        `No assistant instance found with name '${assistantName}'.`,
      );
    } else {
      console.error("No assistant instance found. Run `vellum hatch` first.");
    }
    process.exit(1);
  }

  const resources = entry.resources;
  const baseTunnelOpts = resources
    ? {
        port: resources.gatewayPort,
        workspaceDir: join(resources.instanceDir, ".vellum", "workspace"),
      }
    : {};

  if (provider === "ngrok") {
    await runNgrokTunnel({
      ...baseTunnelOpts,
      preferNginxIngress: await shouldPreferNginxIngress(entry.assistantId),
    });
    return;
  }

  if (provider === "cloudflare") {
    await runCloudflareTunnel({
      ...baseTunnelOpts,
      preferNginxIngress: await shouldPreferNginxIngress(entry.assistantId),
    });
    return;
  }

  throw new Error(`Tunnel provider '${provider}' is not yet implemented.`);
}
