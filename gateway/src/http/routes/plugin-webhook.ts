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
 *
 * A route may also declare that its deliveries carry messages
 * (`IngressRouteSchema.inbound`), which is how a plugin channel receives
 * anything at all. The declaration says where the sender and the chat sit in
 * the vendor's payload, which is the whole reason it exists: with those the
 * gateway can run the same `handleInbound` every built-in channel runs
 * *before* the plugin sees anything. The plugin is then free to act on a
 * delivery the moment it arrives, because everything that could refuse it
 * already has. See `plugin-inbound.ts` for what the gateway reads,
 * `db/inbound-dedup-store.ts` for the redelivery claim, and
 * `deliverGatedInbound` below for the ordering.
 */

import {
  ACCESS_DENIED_NOT_APPROVED_REPLY,
  isTrustClass,
  meetsAdmissionFloor,
  PLUGIN_ADMISSION_DENIED_NOTICE_PATH,
  PluginAdmissionDeniedNoticeSchema,
} from "@vellumai/gateway-client";

import {
  findDeclaredRoute,
  type PluginIngressResolution,
} from "../../channels/plugin-ingress-approvals.js";
import {
  verifyDeclaredSignature,
  type VerificationRejection,
} from "../../channels/ingress-verification.js";
import {
  readPluginInbound,
  unscopedPluginId,
} from "../../channels/plugin-inbound.js";
import type { IngressInbound } from "../../channels/ingress-inbound.js";
import type { IngressSigner } from "../../channels/plugin-ingress.js";
import {
  admitInbound,
  type InboundAdmission,
} from "../../handlers/handle-inbound.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  commitInboundEvent,
  releaseInboundEvent,
  reserveInboundEvent,
} from "../../db/inbound-dedup-store.js";
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

/**
 * What a forward to the plugin needs, gathered once at the route.
 */
interface PluginForward {
  config: GatewayConfig;
  plugin: string;
  /** The declared path, not the requested spelling. */
  routePath: string;
  req: Request;
  /** The vendor's payload, as accepted. */
  body: Uint8Array<ArrayBuffer>;
  search: string;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Hand the vendor's delivery to the plugin, verbatim.
 *
 * The plugin gets what the vendor sent rather than the gateway's reading of
 * it: only the plugin knows which of its vendor's events this is, and the
 * declaration covers just the few fields the gate needs. Re-parsing on the far
 * side is the plugin doing the job it exists for.
 */
async function forwardToPlugin(forward: PluginForward): Promise<Response> {
  const { config, plugin, routePath, req, body, search, fetchImpl } = forward;
  const start = performance.now();
  // The body is already drained, so hand the proxy a request carrying the
  // bytes we accepted rather than the consumed original.
  const forwardable = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: METHODS_WITHOUT_BODY.has(req.method) ? undefined : body,
  });
  const forwarded = await proxyForwardToResponse(forwardable, {
    baseUrl: config.assistantRuntimeBaseUrl,
    // Forward under the declared path, not the requested spelling: matching
    // ignores a trailing slash, and the plugin serves the path it declared.
    path: pluginRouteUpstreamPath(plugin, routePath),
    search: search || undefined,
    serviceToken: mintServiceToken(),
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });
  const duration = Math.round(performance.now() - start);
  if (forwarded.status >= 500) {
    log.error(
      { plugin, path: routePath, status: forwarded.status, duration },
      "Plugin webhook upstream error",
    );
  } else if (forwarded.status >= 400) {
    log.warn(
      { plugin, path: routePath, status: forwarded.status, duration },
      "Plugin webhook upstream error",
    );
  }
  return forwarded;
}

/**
 * Ask the plugin to send the canned access-denial reply.
 *
 * The ranked floor stops the vendor delivery from reaching the plugin, because
 * that path is free to run a turn. The sender still needs to hear that they
 * were not admitted. Only the plugin can send on its vendor, so this is a
 * separate, structured notice: no vendor payload, no turn.
 *
 * The vendor ACK does not depend on this hop. A missing route or a failed
 * send is logged and absorbed.
 */
async function notifyPluginAdmissionDenied(opts: {
  forward: PluginForward;
  plugin: string;
  routePath: string;
  admissionPolicy: string;
  trustClass: string;
  conversationExternalId: string;
  actorExternalId: string;
  externalMessageId: string;
}): Promise<void> {
  const {
    forward,
    plugin,
    routePath,
    admissionPolicy,
    trustClass,
    conversationExternalId,
    actorExternalId,
    externalMessageId,
  } = opts;
  try {
    const notice = PluginAdmissionDeniedNoticeSchema.parse({
      reason: "admission_floor",
      plugin,
      ingressRoute: routePath,
      admissionPolicy,
      trustClass: isTrustClass(trustClass) ? trustClass : "unknown",
      conversationExternalId,
      actorExternalId,
      externalMessageId,
      replyText: ACCESS_DENIED_NOT_APPROVED_REPLY,
    });
    const body = JSON.stringify(notice);
    const noticeReq = new Request(
      "http://gateway/internal/plugin-admission-denied",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    const response = await proxyForwardToResponse(noticeReq, {
      baseUrl: forward.config.assistantRuntimeBaseUrl,
      path: pluginRouteUpstreamPath(plugin, PLUGIN_ADMISSION_DENIED_NOTICE_PATH),
      serviceToken: mintServiceToken(),
      timeoutMs: forward.config.runtimeTimeoutMs,
      fetchImpl: forward.fetchImpl,
    });
    if (response.status >= 400) {
      log.warn(
        { plugin, path: routePath, status: response.status },
        "Plugin admission-denied notice failed",
      );
    }
  } catch (err) {
    log.warn(
      { err, plugin, path: routePath },
      "Plugin admission-denied notice failed",
    );
  }
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

    const search = new URL(req.url).search;

    const forward = {
      config,
      plugin,
      routePath: route.path,
      req,
      body: body.bytes,
      search,
      fetchImpl,
    };

    const inbound = route.inbound;
    if (!inbound) {
      // A route that receives no messages is a plain proxy: nothing to read,
      // nothing to gate.
      return forwardToPlugin(forward);
    }

    return deliverGatedInbound({ inbound, forward });
  };
}

/**
 * Gate a delivery, then hand it to the plugin once.
 *
 * The ordering is the point. The gateway reads the sender and the chat out of
 * the vendor's payload with the route's declaration, runs the same
 * `handleInbound` every built-in channel runs, and only then forwards. A
 * plugin that receives a delivery may therefore act on it immediately, up to
 * and including running an agent turn, because by the time it sees anything
 * the kill switch, the trust verdict and the intercepts have already had their
 * say. Gating after the forward would make all of that advisory.
 *
 * One crossing, not two. The plugin is the only thing downstream, so the
 * runtime hop `handleInbound` would otherwise make is replaced by the forward
 * to the plugin's own route (see `HandleInboundOptions.deliver`), and the
 * plugin owns what happens next: which of its vendor's events this is, whether
 * it becomes a turn, and how a reply goes back out over its own transport.
 *
 * A delivery carrying no sender is not a message the gateway can gate. A
 * vendor's delivery probe is the usual case, and it reaches the plugin
 * ungated, because there is nobody to admit and nothing to admit them to.
 */
async function deliverGatedInbound(opts: {
  inbound: IngressInbound;
  forward: PluginForward;
}): Promise<Response> {
  const { inbound, forward } = opts;
  const { config, plugin, routePath, body } = forward;

  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(body);
    parsed = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    // Authentic but unreadable. The signature checked out, so this is the
    // vendor sending something we cannot parse rather than an attacker; the
    // plugin may still recognise it.
    log.warn(
      { plugin, path: routePath },
      "Plugin webhook payload is not JSON, forwarding ungated",
    );
    return forwardToPlugin(forward);
  }

  const reading = readPluginInbound({
    plugin,
    inbound,
    body: parsed,
    receivedAt: new Date().toISOString(),
  });

  if (reading.status === "none") {
    // The ordinary case for a probe or a receipt: no sender, so no admission
    // decision to make. Debug rather than info, since every such delivery
    // would log otherwise.
    log.debug(
      { plugin, path: routePath },
      "Delivery carries no sender, forwarding ungated",
    );
    return forwardToPlugin(forward);
  }
  if (reading.status === "invalid") {
    // Some of a message but not enough of one. Declining to gate a delivery
    // the declaration half-matched would hand the plugin a sender the gateway
    // never checked, so this is refused outright.
    log.warn(
      { plugin, path: routePath, reason: reading.reason },
      "Delivery matched the inbound declaration only partly, refusing",
    );
    return Response.json({ error: "Bad Request" }, { status: 400 });
  }

  const dedupKey = {
    sourceChannel: reading.event.sourceChannel,
    externalChatId: reading.event.message.conversationExternalId,
    externalMessageId: reading.event.message.externalMessageId,
  };
  if (!reserveInboundEvent(dedupKey)) {
    // Acknowledged, because the delivery did land: the first copy is already
    // through. Anything else asks the vendor to keep sending it.
    log.info(
      {
        plugin,
        path: routePath,
        externalMessageId: dedupKey.externalMessageId,
      },
      "Duplicate plugin inbound delivery, acknowledged without forwarding",
    );
    return Response.json({ ok: true }, { status: 200 });
  }

  let admission: InboundAdmission;
  try {
    admission = await admitInbound(config, reading.event, {
      // Which plugin, for the runtime and for anyone reading a transcript. The
      // route too: a plugin can declare several, and knowing which one a turn
      // arrived on is the difference between a provider misconfiguration and a
      // plugin bug.
      sourceMetadata: { plugin, ingressRoute: routePath },
    });
  } catch (err) {
    // `CircuitBreakerOpenError` reaches here by design: the gate lets it
    // through precisely so a caller can answer retryably instead of 500ing.
    log.error(
      { err, plugin, path: routePath },
      "Plugin inbound message could not be gated",
    );
    // Answering 503 asks for the delivery again, so the claim has to go with
    // it. Keeping it would have the retry we just asked for answered as a
    // duplicate, which is how a message disappears while both sides report
    // having done the right thing.
    releaseInboundEvent(dedupKey);
    return retryLater();
  }

  if (!admission.admitted) {
    // A decision, not a failure: the message reached the gate and the gate
    // said no, or consumed it. Sending it again changes nothing, so the
    // vendor is acknowledged and the claim stands.
    log.info(
      {
        plugin,
        path: routePath,
        rejected: admission.result.rejected,
        rejectionReason: admission.result.rejectionReason,
      },
      "Plugin inbound message was not admitted",
    );
    commitInboundEvent(dedupKey);
    return Response.json({ ok: true }, { status: 200 });
  }

  // The ranked admission floor, which the gate deliberately leaves to whoever
  // receives the message. For a built-in channel that is the runtime's own
  // admission stage; here there is nothing downstream but the plugin, so a
  // floor unenforced here is a floor unenforced at all, and an unknown sender
  // would reach a plugin free to answer them. The vendor body stays here. A
  // separate notice asks the plugin to send the canned denial, which is the
  // same line built-in channels send, without running a turn.
  const { admissionPolicy, trustVerdict } = admission;
  const trustClass = trustVerdict?.trustClass ?? "unknown";
  if (admissionPolicy && !meetsAdmissionFloor(admissionPolicy, trustClass)) {
    log.info(
      {
        plugin,
        path: routePath,
        admissionPolicy,
        trustClass,
      },
      "Plugin inbound message denied by the admission floor",
    );
    await notifyPluginAdmissionDenied({
      forward,
      plugin,
      routePath,
      admissionPolicy,
      trustClass,
      conversationExternalId: unscopedPluginId(
        plugin,
        reading.event.message.conversationExternalId,
      ),
      actorExternalId: unscopedPluginId(
        plugin,
        reading.event.actor.actorExternalId,
      ),
      externalMessageId: unscopedPluginId(
        plugin,
        reading.event.message.externalMessageId,
      ),
    });
    commitInboundEvent(dedupKey);
    return Response.json({ ok: true }, { status: 200 });
  }

  const pluginResponse = await forwardToPlugin(forward);
  if (pluginResponse.status >= 400) {
    // The gate said yes and the plugin could not take it. Acknowledging would
    // lose a message the sender was entitled to have delivered.
    log.error(
      { plugin, path: routePath, status: pluginResponse.status },
      "Plugin refused an admitted delivery",
    );
    releaseInboundEvent(dedupKey);
    return retryLater();
  }

  // The delivery landed, so the claim stops being a lease and becomes the
  // dedup window proper. Until this runs the claim is short-lived on purpose:
  // a gateway that died mid-handoff must not leave a row that answers every
  // retry as already-delivered.
  commitInboundEvent(dedupKey);

  // The vendor gets a bare acknowledgement, never the plugin's body: that was
  // addressed to us, and a plugin handling a delivery should not thereby echo
  // the sender's own message back to the vendor that sent it.
  return Response.json({ ok: true }, { status: pluginResponse?.status ?? 200 });
}

/**
 * Ask the vendor to send this delivery again.
 *
 * 503 with `Retry-After` rather than 500, matching what the built-in webhook
 * handlers answer when the runtime is unreachable: a vendor reading a 500
 * often disables the endpoint, while 503 is the one status every retry policy
 * treats as "later, not never".
 */
function retryLater(): Response {
  return Response.json(
    { error: "Service Unavailable" },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}
