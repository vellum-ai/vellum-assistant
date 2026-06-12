import { homedir } from "node:os";
import { join } from "node:path";

import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
  resolveAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { GATEWAY_PORT } from "../lib/constants.js";
import {
  formatFeatureFlagGateMessage,
  isAssistantFeatureFlagEnabled,
  WEB_REMOTE_INGRESS_FLAG,
} from "../lib/feature-flags.js";
import { waitForDaemonReady } from "../lib/http-client.js";
import {
  DEFAULT_NGINX_INGRESS_PORT,
  getIngressPaths,
  getIngressPid,
  getNginxIngressPort,
  getNginxVersion,
  isIngressRunning,
  resolveTunnelTargetPort,
  startIngressNginx,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";

const READY_TIMEOUT_MS = 5_000;

function printHelp(): void {
  console.log("Usage: vellum nginx-ingress <subcommand> [<name>] [options]");
  console.log("");
  console.log(
    "Manage the nginx reverse proxy that fronts the gateway for remote web",
  );
  console.log(
    "access: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway. While the",
  );
  console.log(
    "nginx ingress is running, `vellum tunnel` targets it instead of the gateway.",
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
    `  VELLUM_NGINX_INGRESS_PORT   nginx ingress loopback listen port (default ${DEFAULT_NGINX_INGRESS_PORT})`,
  );
  console.log("  NGINX_BIN             Path to the nginx binary");
  console.log("");
  console.log("Examples:");
  console.log("  $ vellum nginx-ingress up");
  console.log("  $ vellum nginx-ingress status");
  console.log("  $ vellum nginx-ingress down my-assistant");
  console.log("");
  console.log("Feature flags:");
  console.log(
    `  ${WEB_REMOTE_INGRESS_FLAG} must be enabled to start nginx ingress`,
  );
}

interface NginxIngressTarget {
  assistantId?: string;
  workspaceDir: string;
  gatewayPort: number;
}

function parsePortFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveEntryGatewayPort(entry: AssistantEntry | undefined): number {
  return (
    parsePortFromUrl(entry?.localUrl) ??
    parsePortFromUrl(entry?.runtimeUrl) ??
    GATEWAY_PORT
  );
}

/**
 * Resolve which assistant nginx ingress fronts. Multi-instance hatches allocate
 * per-assistant gateway ports and workspaces, so both must come from the
 * resolved entry's resources. Entries without resources still record their
 * reachable gateway URL, so derive the port from localUrl/runtimeUrl before
 * falling back to the legacy default. Explicit names go through the shared
 * identifier lookup (see cli/AGENTS.md "Assistant targeting convention") so
 * display names resolve and ambiguous matches fail loudly.
 */
export function resolveNginxIngressTarget(
  assistantName: string | null,
): NginxIngressTarget {
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
    workspaceDir:
      process.env.VELLUM_WORKSPACE_DIR?.trim() ||
      join(homedir(), ".vellum", "workspace"),
    gatewayPort: resolveEntryGatewayPort(entry),
  };
}

async function assertWebRemoteIngressEnabled(
  target: NginxIngressTarget,
): Promise<void> {
  if (!target.assistantId) {
    throw new Error(formatFeatureFlagGateMessage(WEB_REMOTE_INGRESS_FLAG));
  }

  let enabled: boolean;
  try {
    enabled = await isAssistantFeatureFlagEnabled(
      target.assistantId,
      WEB_REMOTE_INGRESS_FLAG,
    );
  } catch (err) {
    throw new Error(
      `Could not verify the \`${WEB_REMOTE_INGRESS_FLAG}\` feature flag. Is the assistant running? Try \`vellum wake\` and retry. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!enabled) {
    throw new Error(formatFeatureFlagGateMessage(WEB_REMOTE_INGRESS_FLAG));
  }
}

async function up(target: NginxIngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;
  const listenPort = getNginxIngressPort();

  await assertWebRemoteIngressEnabled(target);

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
    console.log("nginx ingress is already running.");
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
      `Error: nginx ingress did not become reachable on 127.0.0.1:${listenPort}.`,
    );
    console.error(`Check the nginx log: ${logPath}`);
    process.exit(1);
  }

  console.log("");
  console.log(`nginx ingress running: http://127.0.0.1:${listenPort}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    "  vellum tunnel --provider ngrok   # tunnel now targets nginx ingress",
  );
  console.log("  vellum nginx-ingress down        # stop the proxy");
}

async function down(target: NginxIngressTarget): Promise<void> {
  const stopped = await stopIngressNginx(target.workspaceDir);
  if (!stopped && isIngressRunning(target.workspaceDir)) {
    console.error("Error: nginx ingress is still running; could not stop it.");
    process.exit(1);
  }
  console.log(
    stopped ? "nginx ingress stopped." : "nginx ingress is not running.",
  );
}

async function status(target: NginxIngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;
  const { confPath, logPath } = getIngressPaths(workspaceDir);
  const pid = getIngressPid(workspaceDir);
  if (pid === null) {
    console.log("nginx ingress: not running");
    return;
  }
  const { port } = resolveTunnelTargetPort(workspaceDir, gatewayPort);
  console.log("nginx ingress: running");
  console.log(`  PID:     ${pid}`);
  console.log(`  Listen:  http://127.0.0.1:${port}`);
  console.log(`  Gateway: http://127.0.0.1:${gatewayPort}`);
  console.log(`  Config:  ${confPath}`);
  console.log(`  Log:     ${logPath}`);
}

export async function nginxIngress(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    process.exit(sub ? 0 : 1);
  }

  // Joins all remaining positionals so unquoted multi-word display names
  // resolve as one identifier (cli/AGENTS.md "Assistant targeting convention").
  const assistantName = parseAssistantTargetArg(args.slice(1));
  const target = resolveNginxIngressTarget(assistantName ?? null);

  if (sub === "up") return up(target);
  if (sub === "down") return down(target);
  if (sub === "status") return status(target);

  console.error(`Error: Unknown subcommand '${sub}'.`);
  console.error("Run 'vellum nginx-ingress --help' for usage.");
  process.exit(1);
}
