/**
 * WebSocket half of the plugin ingress surface.
 *
 * A plugin declaring `kind: "websocket"` gets a socket the caller dials, but
 * plugin routes are HTTP-only — there is no second socket to hand off to. So
 * the gateway terminates the connection at the edge and hands each frame to
 * the plugin's route over IPC, one at a time per connection so the plugin
 * observes frames in the order they arrived. IPC rather than a loopback HTTP
 * hop because the socket is the trust boundary: the assistant does not
 * re-verify a caller the gateway has already authorised.
 *
 * Frames travel upstream; nothing travels back. Giving the route's response a
 * meaning on the wire would be inventing a protocol neither side has agreed
 * to, so a failure is logged and the socket is left alone.
 *
 * Today a frame must carry a JSON object. The IPC request envelope can carry
 * a binary frame — `writeMessage` sends one and the server's reader parses it
 * — but the server discards it (`void binary` in `assistant-server.ts`) and
 * the gateway's client still speaks the legacy newline protocol, which has no
 * binary frame at all. Until that is fixed, anything else is refused at the
 * socket rather than silently dropped on the way to the plugin.
 */

import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import type { IngressSigner } from "../../channels/plugin-ingress.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
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
 *
 * The count alone is not a memory bound: Bun accepts frames far larger than
 * a webhook payload, so a hundred of them would be gigabytes. Queued bytes
 * are capped as well, and an oversized single frame is refused outright —
 * a frame is a webhook-sized request to the plugin, so
 * `maxWebhookPayloadBytes` is the size that has to hold.
 */
const MAX_PENDING_FRAMES = 100;

/** Total bytes a connection may hold queued, across all pending frames. */
function maxQueuedBytes(config: GatewayConfig): number {
  return config.maxWebhookPayloadBytes * 8;
}

function frameByteLength(frame: string | Uint8Array): number {
  return typeof frame === "string"
    ? Buffer.byteLength(frame, "utf8")
    : frame.byteLength;
}

/** Signature of {@link ipcCallAssistant}, injectable for tests. */
export type IpcCall = (
  method: string,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<unknown>;

export type PluginWebhookSocketData = {
  wsType: "plugin-webhook";
  config: GatewayConfig;
  plugin: string;
  path: string;
  /** Frames waiting on the in-flight delivery. */
  queue: (string | Uint8Array)[];
  /** Bytes held in {@link queue}, tracked so the cap is on memory not count. */
  queuedBytes: number;
  /** True while a delivery is outstanding, so they stay serialised. */
  delivering: boolean;
  closed: boolean;
  ipcCall?: IpcCall;
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
  ipcCall?: IpcCall;
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
  const { config, resolve, credentials, ipcCall } = deps;

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
    // Verify through the refresh helper rather than against the value read
    // above: a secret that rotated while the cache still held the old one
    // would otherwise fail an upgrade that is actually valid.
    const signatureValid = await verifySecretWithRefresh({
      credentials,
      key: secretKey,
      verify: (candidate) =>
        verifyVellumSignature(req.headers, signed, candidate),
      log,
      label: "Plugin webhook WS handshake",
    });
    if (!signatureValid) {
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
        queuedBytes: 0,
        delivering: false,
        closed: false,
        ipcCall,
      } satisfies PluginWebhookSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  };
}

/**
 * The JSON object a frame carries, or null when it does not carry one.
 *
 * Until the IPC request envelope can carry raw bytes, `body` is the only way
 * a frame reaches a route, and it must be an object — `synthesizeRequest`
 * re-serialises it, and the runtime adapter keeps objects only. Anything else
 * is undeliverable rather than merely awkward, so the caller refuses it
 * instead of letting it vanish.
 */
function frameAsJsonObject(
  frame: string | Uint8Array,
): Record<string, unknown> | null {
  if (typeof frame !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(frame);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Hand one frame to the plugin's route over IPC. */
async function deliverFrame(
  data: PluginWebhookSocketData,
  body: Record<string, unknown>,
): Promise<void> {
  const { config, plugin, path } = data;
  const call = data.ipcCall ?? ipcCallAssistant;
  try {
    await call(
      "user_route_post",
      {
        pathParams: { path: `plugins/${plugin}/${path}` },
        queryParams: {},
        body,
        headers: { "content-type": "application/json" },
      },
      { timeoutMs: config.runtimeTimeoutMs },
    );
  } catch (err) {
    log.warn({ err, plugin, path }, "Plugin webhook frame delivery failed");
  }
}

/**
 * Deliver queued frames one at a time.
 *
 * Serialising is the point: the plugin sees `joined` before `left` because
 * the next call does not start until the previous one settles. A delivery
 * that fails is logged and skipped rather than retried — re-sending would
 * reorder it behind frames that have already arrived.
 */
async function drain(data: PluginWebhookSocketData): Promise<void> {
  if (data.delivering) return;
  data.delivering = true;
  try {
    while (data.queue.length > 0 && !data.closed) {
      const frame = data.queue.shift()!;
      data.queuedBytes -= frameByteLength(frame);
      const body = frameAsJsonObject(frame);
      // Enqueueing already rejected anything without one; this is a guard,
      // not a second gate.
      if (body) await deliverFrame(data, body);
    }
  } finally {
    data.delivering = false;
  }
}

/**
 * Refuse the rest of a connection.
 *
 * Marks it closed before asking for the close: `close` is not immediate, and
 * a caller already outrunning us keeps sending in the meantime. Without this
 * every one of those frames would close again.
 */
function refuse(
  ws: import("bun").ServerWebSocket<PluginWebhookSocketData>,
  code: number,
  reason: string,
): void {
  ws.data.closed = true;
  ws.data.queue = [];
  ws.data.queuedBytes = 0;
  ws.close(code, reason);
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

      const frame =
        message instanceof ArrayBuffer ? new Uint8Array(message) : message;
      const size = frameByteLength(frame);

      // Refuse what cannot be delivered, rather than queue it and drop it
      // silently at the far end. 1003 is the code for "received data of a
      // type this endpoint cannot accept", which is exactly the situation
      // until the IPC envelope carries raw frames.
      if (frameAsJsonObject(frame) === null) {
        log.warn(
          {
            plugin: data.plugin,
            path: data.path,
            binary: typeof frame !== "string",
          },
          "Plugin webhook frame is not a JSON object — closing connection",
        );
        refuse(ws, 1003, "Frame must be a JSON object");
        return;
      }

      // A single oversized frame is refused rather than queued: it could
      // never be delivered anyway, since it exceeds what the plugin's route
      // accepts as a webhook payload.
      if (size > data.config.maxWebhookPayloadBytes) {
        log.warn(
          { plugin: data.plugin, path: data.path, size },
          "Plugin webhook frame exceeds the webhook payload cap — closing connection",
        );
        refuse(ws, 1009, "Frame too large");
        return;
      }

      if (
        data.queue.length >= MAX_PENDING_FRAMES ||
        data.queuedBytes + size > maxQueuedBytes(data.config)
      ) {
        log.warn(
          {
            plugin: data.plugin,
            path: data.path,
            queued: data.queue.length,
            queuedBytes: data.queuedBytes,
          },
          "Plugin webhook frame buffer overflow — closing connection",
        );
        refuse(ws, 1008, "Buffer overflow");
        return;
      }

      data.queue.push(frame);
      data.queuedBytes += size;
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
      data.queuedBytes = 0;
      log.info(
        { plugin: data.plugin, path: data.path, code, reason, dropped },
        "Plugin webhook WS closed",
      );
    },
  };
}
