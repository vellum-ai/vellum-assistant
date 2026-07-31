/**
 * Public webhook surface for declared plugin ingress routes.
 *
 * This is where the ingress gate stops being bookkeeping: a request is
 * forwarded only when `findServableRoute` says this exact route may be
 * served. Anything else is a 404, including a declaration awaiting
 * approval, so a route that is not yet servable is indistinguishable from
 * one that was never declared.
 *
 * Requests arrive from the public internet through the Velay tunnel, so
 * approval alone would only decide which paths exist, not who may call them.
 * Every request is therefore signature-checked before it is forwarded, and
 * a route whose secret is missing is refused rather than served unsigned.
 * The declaration picks whose secret that is — see `IngressRouteSchema.signer`.
 */

import {
  findServableRoute,
  type PluginIngressResolution,
} from "../../channels/plugin-ingress-approvals.js";
import type { IngressSigner } from "../../channels/plugin-ingress.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { getLogger } from "../../logger.js";
import { readLimitedBodyBytes } from "../read-limited-body.js";
import { verifyVellumSignature } from "../vellum-signature.js";
import { proxyForwardToResponse } from "@vellumai/assistant-client";

const log = getLogger("plugin-webhook");

/**
 * Credential holding the secret that signs this route.
 *
 * `vellum` routes verify against the platform's own webhook secret — the
 * same credential the email webhook uses — so a plugin that only ever hears
 * from Vellum needs no secret of its own. Everything else verifies against
 * the plugin's, stored under its own service name.
 *
 * The field name is fixed for now; making it configurable per plugin is a
 * later step, along with what the HMAC covers.
 */
function signingCredentialKey(plugin: string, signer: IngressSigner): string {
  return credentialKey(
    signer === "vellum" ? "vellum" : plugin,
    "webhook_secret",
  );
}

/** Methods a Request refuses to carry a body for. */
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

/**
 * Upstream path for a plugin route.
 *
 * The `/v1` prefix is load-bearing: the runtime 404s anything outside it
 * before route matching begins, then strips it and matches the plugin
 * catch-all `x/:path*` (assistant/src/runtime/routes/user-routes.ts).
 */
function pluginRouteUpstreamPath(plugin: string, path: string): string {
  return `/v1/x/plugins/${plugin}/${path}`;
}

export interface PluginWebhookHandlerDeps {
  config: GatewayConfig;
  /** Approved-ingress view; cached by the caller so this stays off the disk. */
  resolve: () => PluginIngressResolution;
  /** Signing secrets, read through the TTL cache so rotation is picked up. */
  credentials: CredentialCache | undefined;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Handle `/webhooks/plugins/:plugin/:path`.
 *
 * The requested path must equal a servable route's declared path. Matching
 * is exact rather than prefix-based: a declaration covers the paths it
 * listed, so serving `<declared>/anything` would hand out reach nobody
 * granted. Exact matching also disposes of traversal, since no `..` segment
 * equals a declared path, and of percent-encoded spellings, which fail
 * closed rather than being decoded into a match.
 */
export function createPluginWebhookHandler(deps: PluginWebhookHandlerDeps) {
  const { config, resolve, credentials, fetchImpl } = deps;

  return async (req: Request, plugin: string, path: string) => {
    let route: ReturnType<typeof findServableRoute>;
    try {
      // WebSocket routes are declared here but upgraded elsewhere; serving one
      // over plain HTTP would be a different thing than was declared.
      route = findServableRoute(resolve(), plugin, path, "http");
    } catch (err) {
      log.error({ err, plugin }, "Failed to resolve plugin ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!route) {
      // Deliberately quiet: this path is reachable by anyone on the internet,
      // so logging every miss at info would hand out a log-flooding lever.
      log.debug({ plugin, path }, "No servable HTTP ingress route");
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    // Cap the body on the streamed bytes before anything forwards it. The
    // caller is unauthenticated and Content-Length is attacker-controlled
    // (and absent on chunked requests), so without this each request could
    // buffer up to the server-wide maxRequestBodySize. See gateway/AGENTS.md.
    const body = await readLimitedBodyBytes(req, config.maxWebhookPayloadBytes);
    if (body.status === "too_large") {
      log.warn({ plugin, path }, "Plugin webhook payload too large");
      return Response.json({ error: "Payload Too Large" }, { status: 413 });
    }
    if (body.status === "unreadable") {
      return Response.json({ error: "Bad Request" }, { status: 400 });
    }

    // Signature check before the forward, and fail-closed when no secret is
    // configured: serving a public route unsigned because its secret is
    // missing would turn a setup mistake into an open endpoint.
    const secretKey = signingCredentialKey(plugin, route.signer);
    const secret = await resolveCredentialWithRefresh(credentials, secretKey);
    if (!secret) {
      log.warn(
        { plugin, path, signer: route.signer },
        "Plugin webhook secret is not configured — rejecting request",
      );
      return Response.json(
        { error: "Webhook secret not configured" },
        { status: 409 },
      );
    }

    const signatureValid = await verifySecretWithRefresh({
      credentials,
      key: secretKey,
      verify: (candidate) =>
        verifyVellumSignature(req.headers, body.bytes, candidate),
      log,
      label: "Plugin webhook signature",
    });
    if (!signatureValid) {
      log.warn(
        { plugin, path, signer: route.signer },
        "Plugin webhook signature verification failed",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const upstreamPath = pluginRouteUpstreamPath(plugin, path);
    const search = new URL(req.url).search;
    const start = performance.now();
    // The body is already drained, so hand the proxy a request carrying the
    // bytes we accepted rather than the consumed original.
    const forwardable = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: METHODS_WITHOUT_BODY.has(req.method) ? undefined : body.bytes,
    });
    const response = await proxyForwardToResponse(forwardable, {
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
