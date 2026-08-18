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
    { enabled?: unknown; publicBaseUrl?: unknown } | undefined;
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
 * Bring the nginx edge back up after a wake or local upgrade and point the
 * webhook auto-tunnel at it. The edge is wanted when webhook integrations are
 * configured or the workspace ingress config is enabled with a saved public
 * URL. A healthy SPA edge whose recorded state already targets the requested
 * gateway port is reused without the `remoteWebConfigHash` comparison
 * `startRemoteWebIngress` performs; injected-config drift (a renamed
 * assistant, a changed hub URL) is repaired by the next explicit
 * `vellum tunnel` or `vellum nginx-ingress up`, not by background wakes.
 * A recorded webhooks-only edge is never reused: it goes through
 * `ensureTunnelEdge` so the wake upgrades it to the SPA edge.
 * Edge failures warn
 * (with the error's install or diagnostic text) and fall back to tunneling the
 * gateway port directly, which `maybeStartNgrokTunnel` only does when webhook
 * integrations are configured, so webhook channels on nginx-less machines
 * keep working, and the caller never fails because of edge problems.
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
    const recorded = isIngressRunning(workspaceDir)
      ? readIngressState(workspaceDir)
      : null;
    let edge: TunnelEdge | null = null;
    if (
      recorded !== null &&
      recorded.gatewayPort === gatewayPort &&
      recorded.includeWebApp
    ) {
      edge = {
        port: recorded.listenPort,
        started: false,
        includesWebApp: true,
      };
    } else {
      try {
        edge = await ensureTunnelEdge({
          assistantId,
          workspaceDir,
          gatewayPort,
        });
      } catch (err) {
        console.warn(
          `   Could not restore the tunnel edge: ${
            err instanceof Error ? err.message : String(err)
          } Bring it up manually with \`vellum nginx-ingress up\`.`,
        );
      }
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
  return maybeStartNgrokTunnel(tunnelTargetPort, workspaceDir);
}
