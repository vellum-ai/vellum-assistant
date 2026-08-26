import type { ChildProcess } from "child_process";

import { selectRestartTunnelRecord } from "@vellumai/service-contracts/ingress";

import {
  loadAllAssistants,
  loadAllAssistantsAcrossEnvs,
  type AssistantEntry,
} from "./assistant-config.js";

import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  loadRawConfig,
  parseGatewayPortFromEntryUrls,
} from "./ingress-config.js";
import {
  ensureTunnelEdge,
  formatEdgeMode,
  isIngressRunning,
  readIngressState,
  type TunnelEdge,
} from "./nginx-ingress.js";
import { waitForDaemonReady } from "./http-client.js";
import { hasWebhookIntegrations, maybeStartNgrokTunnel } from "./ngrok.js";
import { shellArg } from "./shell-arg.js";

/** Matches the Docker hatch path's service-readiness allowance. */
export const DOCKER_GATEWAY_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether the workspace ingress config wants the remote-web edge: explicitly
 * enabled with a saved public URL.
 */
function wantsWebIngress(config: Record<string, unknown>): boolean {
  const ingress = config.ingress as
    | { enabled?: unknown; publicBaseUrl?: unknown }
    | undefined;
  return (
    ingress?.enabled === true &&
    typeof ingress.publicBaseUrl === "string" &&
    ingress.publicBaseUrl.trim() !== ""
  );
}

/**
 * Whether anything wants the nginx edge: webhook integrations or the
 * remote-web ingress config. One config read covers both checks;
 * `maybeStartNgrokTunnel` keeps its own webhook gate for its other callers.
 */
function wantsTunnelEdge(workspaceDir: string): boolean {
  try {
    const config = loadRawConfig(workspaceDir);
    return hasWebhookIntegrations(config) || wantsWebIngress(config);
  } catch {
    return false;
  }
}

/**
 * The `vellum tunnel` invocation that rebuilds this assistant's edge. That
 * command requires `--provider`, and a `<provider>` placeholder would be shell
 * redirection rather than something to paste, so name the provider recorded
 * here; with none recorded, point at the help that lists them.
 *
 * The assistant is named too: an unqualified run targets the active assistant,
 * which on a computer running several is not the one being restored.
 */
function tunnelRestartCommand(
  workspaceDir: string,
  assistantId: string,
): string {
  try {
    const record = selectRestartTunnelRecord(
      loadRawConfig(workspaceDir).ingress,
    );
    if (record) {
      return `vellum tunnel ${shellArg(assistantId)} --provider ${record.provider}`;
    }
  } catch {
    // An unreadable config names no provider; the help pointer still holds.
  }
  return "vellum tunnel --help";
}

/**
 * Listen port of an SPA edge still serving in front of `gatewayPort`, or null
 * when nothing verifiably fronts that gateway (an unrecorded upstream port is
 * unverified, see `IngressState`).
 */
function survivingSpaEdgePort(
  workspaceDir: string,
  gatewayPort: number,
): number | null {
  try {
    const recorded = isIngressRunning(workspaceDir)
      ? readIngressState(workspaceDir)
      : null;
    return recorded?.includeWebApp && recorded.gatewayPort === gatewayPort
      ? recorded.listenPort
      : null;
  } catch {
    return null;
  }
}

/**
 * Bring the nginx edge back up after a wake or local upgrade. The edge is
 * wanted when webhook integrations are configured or the workspace ingress
 * config is enabled with a saved public URL. `ensureTunnelEdge` owns the reuse
 * decision, so a running edge is adopted only while its mode, gateway port,
 * and injected SPA config fingerprint all match what this restore asks for; an
 * edge that drifted in any of those respects (a renamed assistant, a changed
 * hub URL, an older edge template) is restarted rather than adopted, which is
 * what keeps a wake from serving a config the current CLI would never
 * generate.
 *
 * Several of those failures leave the old edge serving (the web-dist preflight
 * bails before it is stopped; a drifted edge whose stop fails is reported as
 * stale), and tunneling the gateway directly would take the edge's
 * sensitive-route denylist out from in front of the tunnel. So a failure warns
 * and reports a surviving SPA edge as the target instead.
 *
 * Returns the loopback port a tunnel should front, or null when no edge is
 * wanted and when none survives a failed rebuild.
 */
export async function restoreTunnelEdge(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
  /** Whether the caller tunnels the gateway port directly when the edge fails,
   *  which is what keeps webhook delivery alive without an edge. */
  gatewayFallback = true,
): Promise<number | null> {
  if (!wantsTunnelEdge(workspaceDir)) {
    return null;
  }
  let edge: TunnelEdge;
  try {
    edge = await ensureTunnelEdge({
      assistantId,
      workspaceDir,
      gatewayPort,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const survivingPort = survivingSpaEdgePort(workspaceDir, gatewayPort);
    const impact =
      survivingPort !== null
        ? `The edge already running on 127.0.0.1:${survivingPort} stays in front of the gateway, serving an outdated config.`
        : gatewayFallback
          ? "Webhooks still work, but the web app is not being served."
          : "The web app and webhook delivery are unavailable until it is rebuilt.";
    console.warn(
      `   Could not restore the tunnel edge: ${detail} ${impact} Run \`${tunnelRestartCommand(workspaceDir, assistantId)}\` to rebuild the edge.`,
    );
    return survivingPort;
  }
  console.log(
    `   Tunnel edge ${edge.started ? "started" : "already running"} on 127.0.0.1:${edge.port} (${formatEdgeMode(
      edge.includesWebApp,
    )}).`,
  );
  return edge.port;
}

/**
 * Whether a container entry may restore the shared default-workspace edge.
 *
 * Waking one container must not repoint another's public endpoint at its own
 * gateway, and `ensureTunnelEdge` cannot make that call: it restarts an edge
 * whose recorded gateway port drifts, which is the hijack itself. Two records
 * establish ownership, and both have to hold because neither survives every
 * teardown: a running edge records its `gatewayPort`, while the saved
 * `ingress.publicBaseUrl` outlives the edge and is mirrored onto its owner's
 * entry as `ingressUrl`. That mirror is optional, so only a rival entry
 * actually claiming the URL disproves ownership; the default workspace is one
 * path shared by every environment, so rivals are looked for across all of
 * them.
 */
function ownsSharedIngress(
  entry: AssistantEntry,
  gatewayPort: number,
  workspaceDir: string,
): boolean {
  if (
    isIngressRunning(workspaceDir) &&
    readIngressState(workspaceDir)?.gatewayPort !== gatewayPort
  ) {
    return false;
  }
  let publicBaseUrl: unknown;
  try {
    publicBaseUrl = (
      loadRawConfig(workspaceDir).ingress as
        | { publicBaseUrl?: unknown }
        | undefined
    )?.publicBaseUrl;
  } catch {
    return true;
  }
  if (typeof publicBaseUrl !== "string" || !publicBaseUrl.trim()) {
    return true;
  }
  if (entry.ingressUrl === publicBaseUrl) {
    return true;
  }
  // The mirror is optional and predates this check, so its absence is not proof
  // of non-ownership: a workspace tunneled before mirroring, or through a
  // caller that omits `assistantId`, has a saved URL that no entry claims.
  // Only another container actually claiming this URL disproves ownership.
  return ![...loadAllAssistantsAcrossEnvs(), ...loadAllAssistants()].some(
    (other) =>
      other.assistantId !== entry.assistantId &&
      isLocalContainerEntry(other) &&
      other.ingressUrl === publicBaseUrl,
  );
}

/**
 * Wake counterpart to `stopContainerTunnelEdge`: bring the shared
 * default-workspace edge back for a container assistant, so a tunnel that
 * survived across sleep (a tailnet serve, a reserved ngrok domain) reaches the
 * gateway again without a manual `vellum tunnel`.
 *
 * No webhook auto-tunnel here. Container wakes have never tracked a spawned
 * ngrok PID, so starting one would leak it past the next sleep.
 */
export async function restoreContainerTunnelEdge(
  entry: AssistantEntry,
  gatewayReadyTimeoutMs = 0,
): Promise<void> {
  if (!isLocalContainerEntry(entry)) {
    return;
  }
  const gatewayPort = parseGatewayPortFromEntryUrls(entry);
  if (gatewayPort === undefined) {
    return;
  }
  const workspaceDir = getDefaultWorkspaceDir();
  if (!ownsSharedIngress(entry, gatewayPort, workspaceDir)) {
    return;
  }
  // Gate before waiting: a container that was never tunneled wants no edge, and
  // must not pay the gateway-readiness wait to find that out.
  if (!wantsTunnelEdge(workspaceDir)) {
    return;
  }
  // `wakeContainers` returns once `docker start` is issued, so on a cold or
  // migration-heavy start the gateway is not listening yet. The edge only waits
  // `INGRESS_READY_TIMEOUT_MS` for /healthz before rolling itself back, so
  // without this the restore would fail on exactly the wakes that need it.
  if (
    gatewayReadyTimeoutMs > 0 &&
    !(await waitForDaemonReady(gatewayPort, gatewayReadyTimeoutMs))
  ) {
    console.warn(
      `   Gateway on 127.0.0.1:${gatewayPort} did not come up, so the tunnel edge was not restored. Run \`${tunnelRestartCommand(workspaceDir, entry.assistantId)}\` once it is running.`,
    );
    return;
  }
  await restoreTunnelEdge(entry.assistantId, gatewayPort, workspaceDir, false);
}

export async function restoreTunnelEdgeAndAutoTunnel(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
): Promise<ChildProcess | null> {
  const edgePort = await restoreTunnelEdge(
    assistantId,
    gatewayPort,
    workspaceDir,
  );
  return maybeStartNgrokTunnel(
    edgePort ?? gatewayPort,
    workspaceDir,
    assistantId,
  );
}
