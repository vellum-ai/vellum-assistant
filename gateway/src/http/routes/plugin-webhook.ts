/**
 * Public webhook surface for approved plugin ingress routes.
 *
 * This is where the ingress gate stops being bookkeeping: a request is
 * forwarded to the plugin only when the guardian has approved a declaration
 * that names exactly this route. Anything else is a 404 — including routes a
 * plugin declares but nobody has approved, so an unapproved declaration is
 * indistinguishable from one that was never made.
 *
 * Requests arrive from the public internet through the Velay tunnel and are
 * unauthenticated, like every other handler under `/webhooks/`. Approval
 * governs which paths exist, not who may call them; a plugin that needs to
 * know its caller must validate a provider signature or shared secret itself,
 * the same obligation the Twilio and Mailgun handlers carry.
 */

import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { proxyForwardToResponse } from "@vellumai/assistant-client";

const log = getLogger("plugin-webhook");

/** Upstream namespace the assistant serves plugin routes from. */
function pluginRouteUpstreamPath(plugin: string, path: string): string {
  return `/x/plugins/${plugin}/${path}`;
}

export interface PluginWebhookHandlerDeps {
  config: GatewayConfig;
  /** Approved-ingress view; cached by the caller so this stays off the disk. */
  resolve: () => PluginIngressResolution;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Handle `/webhooks/plugins/:plugin/:path`.
 *
 * The requested path must equal an approved route's declared path. Matching
 * is exact rather than prefix-based: the digest a guardian approved covers
 * the paths it listed, so serving `<approved>/anything` would hand out reach
 * that was never reviewed. Exact matching also disposes of traversal — no
 * `..` segment equals a declared path — and of percent-encoded spellings,
 * which fail closed rather than being decoded into a match.
 */
export function createPluginWebhookHandler(deps: PluginWebhookHandlerDeps) {
  const { config, resolve, fetchImpl } = deps;

  return async (req: Request, plugin: string, path: string) => {
    let approved: PluginIngressResolution["approved"];
    try {
      approved = resolve().approved;
    } catch (err) {
      log.error({ err, plugin }, "Failed to resolve approved plugin ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    const declaration = approved.find((d) => d.plugin === plugin);
    const route = declaration?.routes.find(
      // WebSocket routes are declared here but upgraded elsewhere; serving
      // one over plain HTTP would be a different thing than was approved.
      (r) => r.kind === "http" && r.path === path,
    );

    if (!route) {
      // Deliberately quiet: this path is reachable by anyone on the internet,
      // so logging every miss at info would hand out a log-flooding lever.
      log.debug({ plugin, path }, "No approved HTTP ingress route");
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    const upstreamPath = pluginRouteUpstreamPath(plugin, path);
    const search = new URL(req.url).search;
    const start = performance.now();
    const response = await proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: search || undefined,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { plugin, path, status: response.status, duration },
        "Plugin webhook upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { plugin, path, status: response.status, duration },
        "Plugin webhook upstream error",
      );
    }

    return response;
  };
}
