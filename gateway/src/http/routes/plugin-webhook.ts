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
 * The declaration picks whose secret that is — see `IngressRouteSchema.signer`
 * — and, for a route a third party calls, how the signature is formed at all
 * (`IngressRouteSchema.verification`).
 */

import {
  findDeclaredRoute,
  type PluginIngressResolution,
} from "../../channels/plugin-ingress-approvals.js";
import {
  verifyDeclaredSignature,
  type VerificationRejection,
} from "../../channels/ingress-verification.js";
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
 * A route declaring `verification` names its own field instead, but only the
 * field: the service half is composed here from the plugin's directory name,
 * so no manifest can point a route at another plugin's secret or at the
 * platform's.
 */
function signingCredentialKey(
  plugin: string,
  route: {
    signer: IngressSigner;
    verification?: { secret: { field: string } };
  },
): string {
  if (route.verification) {
    return credentialKey(plugin, route.verification.secret.field);
  }
  return credentialKey(
    route.signer === "vellum" ? "vellum" : plugin,
    "webhook_secret",
  );
}

/** Methods a Request refuses to carry a body for. */
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

/**
 * The answer for a caller who has not proved who they are.
 *
 * Every refusal on a route that is declared but not servable returns exactly
 * this, whatever went wrong: an oversized body, an unreadable one, a missing
 * secret, a bad signature. Otherwise the differences between those answers
 * would tell an unauthenticated prober that a route is declared and waiting,
 * which is the one thing withholding it is for.
 */
function notFound(): Response {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

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
 * The requested path must equal a declared route's path, up to one trailing
 * slash. Matching is exact rather than prefix-based: a declaration covers the
 * paths it listed, so serving `<declared>/anything` would hand out reach
 * nobody granted. Exact matching also disposes of traversal, since no `..`
 * segment equals a declared path, and of percent-encoded spellings, which
 * fail closed rather than being decoded into a match.
 *
 * The approval gate is consulted after the signature, not before. Both orders
 * refuse the same requests; they differ only in what the caller is told, and
 * the reason to withhold that is the prober, who cannot sign. A caller who can
 * sign with this plugin's own secret is the party the route was declared for,
 * was handed the URL by us, and gets told the route is waiting on approval
 * rather than being sent to look for a URL that is already correct. Everyone
 * else gets {@link notFound}, identically, whatever they got wrong.
 *
 * The cost is one HMAC on requests to a route that cannot be served, bounded
 * by the same body cap as everything else here.
 */
export function createPluginWebhookHandler(deps: PluginWebhookHandlerDeps) {
  const { config, resolve, credentials, fetchImpl } = deps;

  return async (req: Request, plugin: string, path: string) => {
    let match: ReturnType<typeof findDeclaredRoute>;
    try {
      // WebSocket routes are declared here but upgraded elsewhere; serving one
      // over plain HTTP would be a different thing than was declared.
      match = findDeclaredRoute(resolve(), plugin, path, "http");
    } catch (err) {
      log.error({ err, plugin }, "Failed to resolve plugin ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!match) {
      // Deliberately quiet: this path is reachable by anyone on the internet,
      // so logging every miss at info would hand out a log-flooding lever.
      log.debug({ plugin, path }, "No declared HTTP ingress route");
      return notFound();
    }
    const route = match.route;

    // Cap the body on the streamed bytes before anything forwards it. The
    // caller is unauthenticated and Content-Length is attacker-controlled
    // (and absent on chunked requests), so without this each request could
    // buffer up to the server-wide maxRequestBodySize. See gateway/AGENTS.md.
    const body = await readLimitedBodyBytes(req, config.maxWebhookPayloadBytes);
    if (body.status === "too_large") {
      log.warn({ plugin, path }, "Plugin webhook payload too large");
      return match.servable
        ? Response.json({ error: "Payload Too Large" }, { status: 413 })
        : notFound();
    }
    if (body.status === "unreadable") {
      return match.servable
        ? Response.json({ error: "Bad Request" }, { status: 400 })
        : notFound();
    }

    // Signature check before the forward, and fail-closed when no secret is
    // configured: serving a public route unsigned because its secret is
    // missing would turn a setup mistake into an open endpoint.
    const verification = route.verification;
    const secretKey = signingCredentialKey(plugin, route);
    const secret = await resolveCredentialWithRefresh(credentials, secretKey);
    if (!secret) {
      log.warn(
        { plugin, path, signer: route.signer, secretKey },
        "Plugin webhook secret is not configured, rejecting request",
      );
      return match.servable
        ? Response.json(
            { error: "Webhook secret not configured" },
            { status: 409 },
          )
        : notFound();
    }

    // Kept for the log line only. The retry inside verifySecretWithRefresh can
    // overwrite it, which is what we want: the reason reported is the one from
    // the last secret tried, not the stale-cache attempt that preceded it.
    let rejection: VerificationRejection | undefined;
    const signatureValid = await verifySecretWithRefresh({
      credentials,
      key: secretKey,
      verify: (candidate) => {
        if (!verification) {
          return verifyVellumSignature(req.headers, body.bytes, candidate);
        }
        const result = verifyDeclaredSignature({
          verification,
          headers: req.headers,
          body: body.bytes,
          secret: candidate,
        });
        rejection = result.ok ? undefined : result.reason;
        return result.ok;
      },
      log,
      label: "Plugin webhook signature",
    });
    if (!signatureValid) {
      log.warn(
        {
          plugin,
          path,
          signer: route.signer,
          scheme: verification?.kind ?? "vellum",
          rejection,
        },
        "Plugin webhook signature verification failed",
      );
      return match.servable
        ? Response.json({ error: "Forbidden" }, { status: 403 })
        : notFound();
    }

    // Verified, and only now does the gate speak. The caller signed with this
    // plugin's own secret, so they are the party the route was declared for and
    // already know it exists; 404ing them here is the answer written for a
    // prober, and it reads as "wrong URL", which sends whoever is debugging to
    // the one thing that is not wrong.
    if (!match.servable) {
      log.info(
        { plugin, path, signer: route.signer },
        "Verified delivery to an ingress route awaiting guardian approval",
      );
      return Response.json(
        {
          error: "Ingress route awaiting approval",
          detail:
            `The route "${path}" is declared by the "${plugin}" plugin but a ` +
            "guardian has not approved its ingress declaration yet, so the " +
            "gateway is not serving it. Deliveries are refused, not queued.",
        },
        { status: 409 },
      );
    }

    // Forward under the declared path, not the requested spelling: matching
    // ignores a trailing slash, and the plugin serves the path it declared.
    const upstreamPath = pluginRouteUpstreamPath(plugin, route.path);
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
