import {
  findAssistantByName,
  loadLatestAssistant,
} from "../lib/assistant-config";
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
      console.log("Usage: assistant tunnel [<name>] [options]");
      console.log("");
      console.log("Create a tunnel for a locally hosted assistant.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>                        Name of the assistant (defaults to latest)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        `  --provider <provider>         Tunnel provider: ${VALID_PROVIDERS.join(", ")} (default: ${DEFAULT_PROVIDER})`,
      );
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

export async function tunnel(): Promise<void> {
  const { assistantName, provider } = parseArgs();

  const entry = assistantName
    ? findAssistantByName(assistantName)
    : loadLatestAssistant();

  if (!entry) {
    if (assistantName) {
      console.error(
        `No assistant instance found with name '${assistantName}'.`,
      );
    } else {
      console.error(
        "No assistant instance found. Run `assistant hatch` first.",
      );
    }
    process.exit(1);
  }

  if (provider === "ngrok") {
    await runNgrokTunnel();
    return;
  }

  throw new Error(`Tunnel provider '${provider}' is not yet implemented.`);
}
