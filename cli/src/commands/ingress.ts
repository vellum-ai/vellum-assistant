import { join } from "node:path";

import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
  resolveAssistant,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args";
import { GATEWAY_PORT } from "../lib/constants";
import { waitForDaemonReady } from "../lib/http-client.js";
import {
  DEFAULT_INGRESS_PORT,
  getIngressPaths,
  getIngressPid,
  getIngressPort,
  getNginxVersion,
  isIngressRunning,
  resolveTunnelTargetPort,
  startIngressNginx,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";
import { getDefaultWorkspaceDir } from "../lib/workspace-config.js";

const FLAG_KEY = "web-remote-ingress";

const READY_TIMEOUT_MS = 5_000;

function printHelp(): void {
  console.log("Usage: vellum ingress <subcommand> [<name>] [options]");
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
  console.log("Arguments:");
  console.log(
    "  <name>   Name of the assistant (defaults to active or only local)",
  );
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

interface IngressTarget {
  assistantId: string | undefined;
  workspaceDir: string;
  gatewayPort: number;
}

/**
 * Resolve which assistant the ingress fronts. Multi-instance hatches allocate
 * per-assistant gateway ports and workspaces, so both must come from the
 * resolved entry's resources — falling back to the legacy default paths only
 * when no resource configuration exists. Explicit names go through the shared
 * identifier lookup (see cli/AGENTS.md "Assistant targeting convention") so
 * display names resolve and ambiguous matches fail loudly.
 */
function resolveIngressTarget(assistantName: string | null): IngressTarget {
  let entry: AssistantEntry | undefined;
  if (assistantName) {
    const result = lookupAssistantByIdentifier(assistantName);
    if (result.status !== "found") {
      throw new Error(formatAssistantLookupError(assistantName, result));
    }
    entry = result.entry;
  } else {
    entry = resolveAssistant() ?? undefined;
  }
  if (entry?.resources) {
    return {
      assistantId: entry.assistantId,
      workspaceDir: join(entry.resources.instanceDir, ".vellum", "workspace"),
      gatewayPort: entry.resources.gatewayPort,
    };
  }
  return {
    assistantId: entry?.assistantId,
    workspaceDir: getDefaultWorkspaceDir(),
    gatewayPort: GATEWAY_PORT,
  };
}

type FlagsResponse = {
  flags: Array<{ key: string; enabled: boolean }>;
};

/**
 * Require the web-remote-ingress feature flag via the gateway's merged flag
 * state. Doubles as the "is the gateway running?" precondition — if the
 * gateway is unreachable this throws a clear error before nginx is spawned.
 */
async function requireFeatureFlag(
  assistantId: string | undefined,
): Promise<void> {
  let client: AssistantClient;
  try {
    client = new AssistantClient(assistantId ? { assistantId } : undefined);
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

async function up(target: IngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;
  const listenPort = getIngressPort();

  await requireFeatureFlag(target.assistantId);

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
    await status(target);
    return;
  }

  console.log(`Using ${version}`);
  console.log(
    `Starting nginx ingress on 127.0.0.1:${listenPort} → gateway 127.0.0.1:${gatewayPort}...`,
  );

  const child = startIngressNginx({
    workspaceDir,
    gatewayPort,
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

async function down(target: IngressTarget): Promise<void> {
  const stopped = await stopIngressNginx(target.workspaceDir);
  console.log(stopped ? "Ingress stopped." : "Ingress is not running.");
}

async function status(target: IngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;
  const { confPath, logPath } = getIngressPaths(workspaceDir);
  const pid = getIngressPid(workspaceDir);
  if (pid === null) {
    console.log("Ingress: not running");
    return;
  }
  const { port } = resolveTunnelTargetPort(workspaceDir, gatewayPort);
  console.log("Ingress: running");
  console.log(`  PID:     ${pid}`);
  console.log(`  Listen:  http://127.0.0.1:${port}`);
  console.log(`  Gateway: http://127.0.0.1:${gatewayPort}`);
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

  // Joins all remaining positionals so unquoted multi-word display names
  // resolve as one identifier (cli/AGENTS.md "Assistant targeting convention").
  const assistantName = parseAssistantTargetArg(args.slice(1));
  const target = resolveIngressTarget(assistantName ?? null);

  if (sub === "up") return up(target);
  if (sub === "down") return down(target);
  if (sub === "status") return status(target);

  console.error(`Error: Unknown subcommand '${sub}'.`);
  console.error("Run 'vellum ingress --help' for usage.");
  process.exit(1);
}
