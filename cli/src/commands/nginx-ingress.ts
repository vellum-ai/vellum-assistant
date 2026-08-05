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
import { WEB_REMOTE_INGRESS_FLAG } from "../lib/feature-flags.js";
import {
  DEFAULT_NGINX_INGRESS_PORT,
  ensureTunnelEdge,
  formatEdgeMode,
  getIngressPaths,
  getIngressPid,
  getNginxIngressPort,
  isIngressRunning,
  readIngressState,
  stopIngressNginx,
  type TunnelEdge,
} from "../lib/nginx-ingress.js";

function printHelp(): void {
  console.log("Usage: vellum nginx-ingress <subcommand> [<name>] [options]");
  console.log("");
  console.log("Manage the nginx edge that fronts the gateway for tunnel");
  console.log("traffic: browser/webhooks → tunnel (TLS) → nginx@127.0.0.1.");
  console.log(
    "`vellum tunnel` starts or reuses this edge automatically; use this",
  );
  console.log(
    "command as plumbing: check status, stop the edge, or start it for a",
  );
  console.log("bring-your-own HTTPS front (e.g. `tailscale serve`).");
  console.log("");
  console.log("Subcommands:");
  console.log("  up       Generate the nginx config and start the edge");
  console.log("  down     Stop the edge");
  console.log(
    "  status   Show whether the edge is running, its mode, and where",
  );
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
    `  VELLUM_NGINX_INGRESS_PORT   nginx edge loopback listen port (default ${DEFAULT_NGINX_INGRESS_PORT})`,
  );
  console.log("  NGINX_BIN             Path to the nginx binary");
  console.log("");
  console.log("Examples:");
  console.log("  $ vellum nginx-ingress status");
  console.log("  $ vellum nginx-ingress up");
  console.log("  $ vellum nginx-ingress down my-assistant");
  console.log("");
  console.log("Feature flags:");
  console.log(
    `  ${WEB_REMOTE_INGRESS_FLAG} selects the edge mode: enabled serves the`,
  );
  console.log(
    "  remote web app alongside webhooks; disabled starts a webhooks-only",
  );
  console.log("  proxy.");
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

/**
 * Derive the gateway port from an entry's recorded URLs, preferring the
 * loopback `localUrl` over `runtimeUrl`. Undefined when neither carries an
 * explicit port (e.g. a platform-hosted https runtime URL).
 */
export function parseGatewayPortFromEntryUrls(
  entry: AssistantEntry | undefined,
): number | undefined {
  return (
    parsePortFromUrl(entry?.localUrl) ?? parsePortFromUrl(entry?.runtimeUrl)
  );
}

function resolveEntryGatewayPort(entry: AssistantEntry | undefined): number {
  return parseGatewayPortFromEntryUrls(entry) ?? GATEWAY_PORT;
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

export async function up(target: NginxIngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;

  let edge: TunnelEdge;
  try {
    edge = await ensureTunnelEdge({
      assistantId: target.assistantId,
      workspaceDir,
      gatewayPort,
      onStarting: ({ version, webDistDir, listenPort }) => {
        console.log(`Using ${version}`);
        const webSegment = webDistDir ? `web ${webDistDir} + ` : "";
        console.log(
          `Starting nginx ingress on 127.0.0.1:${listenPort} → ${webSegment}gateway 127.0.0.1:${gatewayPort}...`,
        );
      },
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const mode = formatEdgeMode(edge.includesWebApp);

  if (!edge.started) {
    console.log(`nginx ingress is already running (${mode}).`);
    await status(target);
    return;
  }

  console.log("");
  console.log(`nginx ingress running: http://127.0.0.1:${edge.port} (${mode})`);
  if (!edge.includesWebApp) {
    console.log(
      `Enable the ${WEB_REMOTE_INGRESS_FLAG} feature flag to also serve the web app remotely.`,
    );
  }
  console.log("");
  console.log("Next steps:");
  console.log(
    "  vellum tunnel --provider ngrok   # put an HTTPS front on this edge",
  );
  console.log(
    "                                   # (cloudflare and tailscale work too)",
  );
  console.log("  vellum nginx-ingress down        # stop the edge");
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

export async function status(target: NginxIngressTarget): Promise<void> {
  const { workspaceDir, gatewayPort } = target;
  const { confPath, logPath } = getIngressPaths(workspaceDir);
  const pid = getIngressPid(workspaceDir);
  if (pid === null) {
    console.log("nginx ingress: not running");
    return;
  }
  const state = readIngressState(workspaceDir);
  const listenPort = state?.listenPort ?? getNginxIngressPort();
  const mode = formatEdgeMode(state?.includeWebApp ?? true);
  // The recorded gateway port is what the running edge proxies; a state
  // record without gatewayPort is unverified.
  const gatewayLine =
    state?.gatewayPort !== undefined
      ? `http://127.0.0.1:${state.gatewayPort}`
      : `http://127.0.0.1:${gatewayPort} (unverified)`;
  console.log("nginx ingress: running");
  console.log(`  PID:     ${pid}`);
  console.log(`  Mode:    ${mode}`);
  console.log(`  Listen:  http://127.0.0.1:${listenPort}`);
  console.log(`  Gateway: ${gatewayLine}`);
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
