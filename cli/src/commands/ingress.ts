import { AssistantClient } from "../lib/assistant-client.js";
import { GATEWAY_PORT } from "../lib/constants";
import { waitForDaemonReady } from "../lib/http-client.js";
import {
  DEFAULT_INGRESS_PORT,
  getIngressPaths,
  getIngressPort,
  getNginxVersion,
  isIngressRunning,
  resolveTunnelTargetPort,
  startIngressNginx,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";
import { isProcessAlive } from "../lib/process.js";
import { getDefaultWorkspaceDir } from "../lib/workspace-config.js";

const FLAG_KEY = "web-remote-ingress";

const READY_TIMEOUT_MS = 5_000;

function printHelp(): void {
  console.log("Usage: vellum ingress <subcommand> [options]");
  console.log("");
  console.log(
    "Manage the nginx reverse proxy that fronts the gateway for remote web",
  );
  console.log(
    "access: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway. While the",
  );
  console.log(
    "ingress is running, `vellum tunnel` targets it instead of the gateway.",
  );
  console.log("");
  console.log("Subcommands:");
  console.log("  up       Generate the nginx config and start the proxy");
  console.log("  down     Stop the proxy");
  console.log("  status   Show whether the proxy is running and where");
  console.log("");
  console.log("Options:");
  console.log("  --help, -h   Show this help");
  console.log("");
  console.log("Environment:");
  console.log(
    `  VELLUM_INGRESS_PORT   Loopback listen port (default ${DEFAULT_INGRESS_PORT})`,
  );
  console.log("  NGINX_BIN             Path to the nginx binary");
  console.log("");
  console.log(`Requires the '${FLAG_KEY}' feature flag:`);
  console.log(`  $ vellum flags set ${FLAG_KEY} true`);
}

type FlagsResponse = {
  flags: Array<{ key: string; enabled: boolean }>;
};

/**
 * Require the web-remote-ingress feature flag via the gateway's merged flag
 * state. Doubles as the "is the gateway running?" precondition — if the
 * gateway is unreachable this throws a clear error before nginx is spawned.
 */
async function requireFeatureFlag(): Promise<void> {
  let client: AssistantClient;
  try {
    client = new AssistantClient();
  } catch {
    throw new Error("No assistant found. Hatch one with 'vellum hatch' first.");
  }
  let res: Response;
  try {
    res = await client.get("/feature-flags");
  } catch {
    throw new Error(
      "Could not reach the assistant gateway. Is it running? Try 'vellum wake'.",
    );
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch feature flags: HTTP ${res.status}`);
  }
  const data = (await res.json()) as FlagsResponse;
  const flag = data.flags.find((f) => f.key === FLAG_KEY);
  if (!flag?.enabled) {
    throw new Error(
      `The '${FLAG_KEY}' feature flag is disabled. Enable it with:\n` +
        `  vellum flags set ${FLAG_KEY} true`,
    );
  }
}

async function up(): Promise<void> {
  const workspaceDir = getDefaultWorkspaceDir();
  const listenPort = getIngressPort();

  await requireFeatureFlag();

  const version = getNginxVersion();
  if (!version) {
    console.error("Error: nginx is not installed.");
    console.error("");
    console.error("Install nginx:");
    console.error("  macOS:  brew install nginx");
    console.error("  Linux:  sudo apt install nginx");
    console.error("");
    console.error(
      "Or point NGINX_BIN at an existing binary: NGINX_BIN=/path/to/nginx",
    );
    process.exit(1);
  }

  if (isIngressRunning(workspaceDir)) {
    console.log("Ingress is already running.");
    await status();
    return;
  }

  console.log(`Using ${version}`);
  console.log(
    `Starting nginx ingress on 127.0.0.1:${listenPort} → gateway 127.0.0.1:${GATEWAY_PORT}...`,
  );

  const child = startIngressNginx({
    workspaceDir,
    gatewayPort: GATEWAY_PORT,
    listenPort,
  });
  child.unref();

  // /healthz proxies through nginx to the gateway, so a 200 proves the whole
  // ingress → gateway path works.
  const ready = await waitForDaemonReady(listenPort, READY_TIMEOUT_MS);
  if (!ready) {
    const { logPath } = getIngressPaths(workspaceDir);
    await stopIngressNginx(workspaceDir);
    console.error(
      `Error: ingress did not become reachable on 127.0.0.1:${listenPort}.`,
    );
    console.error(`Check the nginx log: ${logPath}`);
    process.exit(1);
  }

  console.log("");
  console.log(`Ingress running: http://127.0.0.1:${listenPort}`);
  console.log("");
  console.log(
    "⚠ The gateway MUST run with GATEWAY_TRUST_PROXY=true. Without it, the",
  );
  console.log(
    "  gateway cannot distinguish tunneled remote callers from local ones.",
  );
  console.log("");
  console.log("Next steps:");
  console.log(
    "  vellum tunnel --provider ngrok   # tunnel now targets the ingress",
  );
  console.log("  vellum ingress down              # stop the proxy");
}

async function down(): Promise<void> {
  const workspaceDir = getDefaultWorkspaceDir();
  const stopped = await stopIngressNginx(workspaceDir);
  console.log(stopped ? "Ingress stopped." : "Ingress is not running.");
}

async function status(): Promise<void> {
  const workspaceDir = getDefaultWorkspaceDir();
  const { confPath, logPath, pidPath } = getIngressPaths(workspaceDir);
  const { alive, pid } = isProcessAlive(pidPath);
  if (!alive) {
    console.log("Ingress: not running");
    return;
  }
  const { port } = resolveTunnelTargetPort(workspaceDir);
  console.log("Ingress: running");
  console.log(`  PID:     ${pid}`);
  console.log(`  Listen:  http://127.0.0.1:${port}`);
  console.log(`  Gateway: http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`  Config:  ${confPath}`);
  console.log(`  Log:     ${logPath}`);
}

export async function ingress(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    process.exit(sub ? 0 : 1);
  }

  if (sub === "up") return up();
  if (sub === "down") return down();
  if (sub === "status") return status();

  console.error(`Error: Unknown subcommand '${sub}'.`);
  console.error("Run 'vellum ingress --help' for usage.");
  process.exit(1);
}
