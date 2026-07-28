/**
 * WebSocket half of the plugin ingress surface.
 *
 * A plugin declaring `kind: "websocket"` gets a socket the caller dials, but
 * plugin routes are HTTP-only — there is no second socket to hand off to. So
 * the gateway terminates the connection at the edge and POSTs each frame to
 * the plugin's route, one at a time per connection so the plugin observes
 * frames in the order they arrived.
 *
 * Frames travel upstream; nothing travels back. Giving the plugin's HTTP
 * response a meaning on the wire would be inventing a protocol neither side
 * has agreed to, so a non-2xx is logged and the socket is left alone.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import type { IngressSigner } from "../../channels/plugin-ingress.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { resolveCredentialWithRefresh } from "../../credential-refresh.js";
import { getLogger } from "../../logger.js";
import {
  VELLUM_TIMESTAMP_HEADER,
  handshakeSignedPayload,
  timestampWithinTolerance,
  verifyVellumSignature,
} from "../vellum-signature.js";

const log = getLogger("plugin-webhook-ws");

/**
 * Frames buffered while a delivery is in flight. Matches the STT relay's cap
 * — a caller that outruns the plugin is disconnected rather than allowed to
 * grow the gateway's heap.
 */
const MAX_PENDING_FRAMES = 100;

export type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PluginWebhookSocketData = {
  wsType: "plugin-webhook";
  config: GatewayConfig;
  plugin: string;
  path: string;
  /** Frames waiting on the in-flight delivery. */
  queue: (string | Uint8Array)[];
  /** True while a POST is outstanding, so deliveries stay serialised. */
  delivering: boolean;
  closed: boolean;
  fetchImpl?: FetchImpl;
};

export function isPluginWebhookSocketData(
  data: unknown,
): data is PluginWebhookSocketData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { wsType?: unknown }).wsType === "plugin-webhook"
  );
}

function signingCredentialKey(plugin: string, signer: IngressSigner): string {
  return credentialKey(
    signer === "vellum" ? "vellum" : plugin,
    "webhook_secret",
  );
}

export interface PluginWebhookWsDeps {
  config: GatewayConfig;
  resolve: () => PluginIngressResolution;
  credentials: CredentialCache | undefined;
  fetchImpl?: FetchImpl;
}

/**
 * Upgrade handler for `/webhooks/plugins/:plugin/:path`.
 *
 * Applies the same gate as the HTTP half — only a guardian-approved
 * declaration naming exactly this path is served, and only for the
 * `websocket` kind — then authenticates the handshake before upgrading. An
 * upgrade cannot be un-done once accepted, so everything is checked first.
 */
export function createPluginWebhookWebsocketHandler(deps: PluginWebhookWsDeps) {
  const { config, resolve, credentials, fetchImpl } = deps;

  return async function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
    plugin: string,
    path: string,
  ): Promise<Response | undefined> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    let approved: PluginIngressResolution["approved"];
    try {
      approved = resolve().approved;
    } catch (err) {
      log.error({ err, plugin }, "Failed to resolve approved plugin ingress");
      return new Response("Internal Server Error", { status: 500 });
    }

    const route = approved
      .find((d) => d.plugin === plugin)
      ?.routes.find((r) => r.kind === "websocket" && r.path === path);
    if (!route) {
      // Quiet for the same reason as the HTTP half: anyone can reach this.
      log.debug({ plugin, path }, "No approved websocket ingress route");
      return new Response("Not Found", { status: 404 });
    }

    const secretKey = signingCredentialKey(plugin, route.signer);
    const secret = await resolveCredentialWithRefresh(credentials, secretKey);
    if (!secret) {
      log.warn(
        { plugin, path, signer: route.signer },
        "Plugin webhook secret is not configured — refusing upgrade",
      );
      return new Response("Webhook secret not configured", { status: 409 });
    }

    // A handshake carries no body to sign, so the signature covers the
    // timestamp and the path instead, and the timestamp bounds how long a
    // captured handshake stays usable.
    const timestamp = req.headers.get(VELLUM_TIMESTAMP_HEADER);
    if (!timestamp || !timestampWithinTolerance(timestamp)) {
      log.warn(
        { plugin, path },
        "Plugin webhook WS: missing or stale timestamp",
      );
      return new Response("Forbidden", { status: 403 });
    }
    const signed = handshakeSignedPayload(timestamp, new URL(req.url).pathname);
    if (!verifyVellumSignature(req.headers, signed, secret)) {
      log.warn(
        { plugin, path, signer: route.signer },
        "Plugin webhook WS: signature verification failed",
      );
      return new Response("Forbidden", { status: 403 });
    }

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "plugin-webhook",
        config,
        plugin,
        path,
        queue: [],
        delivering: false,
        closed: false,
        fetchImpl,
      } satisfies PluginWebhookSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  };
}

/** POST one frame to the plugin's route. */
async function deliverFrame(
  data: PluginWebhookSocketData,
  frame: string | Uint8Array,
): Promise<void> {
  const { config, plugin, path } = data;
  const doFetch = data.fetchImpl ?? fetch;
  const url = `${config.assistantRuntimeBaseUrl}/v1/x/plugins/${plugin}/${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.runtimeTimeoutMs);
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintServiceToken()}`,
        "content-type":
          typeof frame === "string"
            ? "application/json"
            : "application/octet-stream",
      },
      // Uint8Array is a valid BodyInit at runtime; the DOM lib types only
      // admit the ArrayBufferView union it is a member of.
      body: frame as BodyInit,
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn(
        { plugin, path, status: response.status },
        "Plugin webhook frame rejected by plugin route",
      );
    }
    // Drain so the connection is returned to the pool rather than held open
    // by an unread body.
    await response.arrayBuffer().catch(() => undefined);
  } catch (err) {
    log.warn({ err, plugin, path }, "Plugin webhook frame delivery failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver queued frames one at a time.
 *
 * Serialising is the point: the plugin sees `joined` before `left` because
 * the next POST does not start until the previous one settles. A delivery
 * that fails is logged and skipped rather than retried — re-sending would
 * reorder it behind frames that have already arrived.
 */
async function drain(data: PluginWebhookSocketData): Promise<void> {
  if (data.delivering) return;
  data.delivering = true;
  try {
    while (data.queue.length > 0 && !data.closed) {
      const frame = data.queue.shift()!;
      await deliverFrame(data, frame);
    }
  } finally {
    data.delivering = false;
  }
}

export function getPluginWebhookWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<PluginWebhookSocketData>) {
      log.info(
        { plugin: ws.data.plugin, path: ws.data.path },
        "Plugin webhook WS opened",
      );
    },

    message(
      ws: import("bun").ServerWebSocket<PluginWebhookSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      const data = ws.data;
      if (data.closed) return;

      if (data.queue.length >= MAX_PENDING_FRAMES) {
        log.warn(
          { plugin: data.plugin, path: data.path },
          "Plugin webhook frame buffer overflow — closing connection",
        );
        // Mark closed before asking for the close: `close` is not immediate,
        // and a caller that is already outrunning us will keep sending in the
        // meantime. Without this every one of those frames closes again.
        data.closed = true;
        data.queue = [];
        ws.close(1008, "Buffer overflow");
        return;
      }

      const frame =
        message instanceof ArrayBuffer ? new Uint8Array(message) : message;
      data.queue.push(frame);
      void drain(data);
    },

    close(
      ws: import("bun").ServerWebSocket<PluginWebhookSocketData>,
      code: number,
      reason: string,
    ) {
      const data = ws.data;
      data.closed = true;
      // Frames not yet delivered are dropped: the caller is gone, and the
      // plugin's view should not gain events after the stream ended.
      const dropped = data.queue.length;
      data.queue = [];
      log.info(
        { plugin: data.plugin, path: data.path, code, reason, dropped },
        "Plugin webhook WS closed",
      );
    },
  };
}
