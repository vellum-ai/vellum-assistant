import { findAssistantByName, loadLatestAssistant } from "../lib/assistant-config";
import {
  clearIngressUrl,
  findExistingTunnel,
  getGatewayPort,
  getNgrokVersion,
  saveIngressUrl,
  startNgrokProcess,
  waitForNgrokUrl,
} from "../lib/ngrok";

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

async function runNgrokTunnel(): Promise<void> {
  const version = getNgrokVersion();
  if (!version) {
    console.error("Error: ngrok is not installed.");
    console.error("");
    console.error("Install ngrok:");
    console.error("  macOS:  brew install ngrok/ngrok/ngrok");
    console.error("  Linux:  sudo snap install ngrok");
    console.error("");
    console.error(
      "Then authenticate: ngrok config add-authtoken <your-token>",
    );
    console.error(
      "  Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken",
    );
    process.exit(1);
  }

  console.log(`Using ${version}`);

  const port = getGatewayPort();

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

  ngrokProcess.on("error", (err) => {
    console.error(`ngrok process error: ${err.message}`);
    process.exit(1);
  });

  ngrokProcess.on("exit", (code) => {
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
    ngrokProcess!.on("exit", () => resolve());
  });
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
        "No assistant instance found. Run `vellum hatch` first.",
      );
    }
    process.exit(1);
  }

  if (provider === "ngrok") {
    await runNgrokTunnel();
    return;
  }

  throw new Error(
    `Tunnel provider '${provider}' is not yet implemented.`,
  );
}
