import type { ChildProcess } from "child_process";

import { loadRawConfig } from "./ingress-config.js";
import {
  ensureTunnelEdge,
  formatEdgeMode,
  isIngressRunning,
  readIngressState,
  type TunnelEdge,
} from "./nginx-ingress.js";
import { hasWebhookIntegrations, maybeStartNgrokTunnel } from "./ngrok.js";

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
 * Bring the nginx edge back up after a wake or local upgrade and point the
 * webhook auto-tunnel at it. The edge is wanted when webhook integrations are
 * configured or the workspace ingress config is enabled with a saved public
 * URL. `ensureTunnelEdge` owns the reuse decision, so a running edge is adopted
 * only while its mode, gateway port, and injected SPA config fingerprint all
 * match what this restore asks for; an edge that drifted in any of those
 * respects (a renamed assistant, a changed hub URL, an older edge template) is
 * restarted rather than adopted, which is what keeps a wake from serving a
 * config the current CLI would never generate.
 *
 * Several of those failures leave the old edge serving (the web-dist preflight
 * bails before it is stopped; a drifted edge whose stop fails is reported as
 * stale), and tunneling the gateway directly would take the edge's
 * sensitive-route denylist out from in front of the tunnel. So a failure warns
 * and keeps a surviving SPA edge as the target; the gateway port is the target
 * only when nothing fronts it, which `maybeStartNgrokTunnel` tunnels only when
 * webhook integrations are configured, so webhook channels on nginx-less
 * machines keep working and the caller never fails because of edge problems.
 *
 * Returns the spawned ngrok child (for PID tracking) or null.
 */
export async function restoreTunnelEdgeAndAutoTunnel(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
): Promise<ChildProcess | null> {
  let tunnelTargetPort = gatewayPort;
  if (wantsTunnelEdge(workspaceDir)) {
    let edge: TunnelEdge | null = null;
    try {
      edge = await ensureTunnelEdge({
        assistantId,
        workspaceDir,
        gatewayPort,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const survivingPort = survivingSpaEdgePort(workspaceDir, gatewayPort);
      if (survivingPort !== null) {
        tunnelTargetPort = survivingPort;
      }
      const hint =
        survivingPort === null
          ? "Bring it up manually with `vellum nginx-ingress up`."
          : `The edge already running on 127.0.0.1:${survivingPort} stays in front of the gateway, serving an outdated config until \`vellum nginx-ingress down\` then \`vellum nginx-ingress up\` rebuilds it.`;
      console.warn(`   Could not restore the tunnel edge: ${detail} ${hint}`);
    }
    if (edge) {
      tunnelTargetPort = edge.port;
      console.log(
        `   Tunnel edge ${edge.started ? "started" : "already running"} on 127.0.0.1:${edge.port} (${formatEdgeMode(
          edge.includesWebApp,
        )}).`,
      );
    }
  }
  return maybeStartNgrokTunnel(tunnelTargetPort, workspaceDir, assistantId);
}
