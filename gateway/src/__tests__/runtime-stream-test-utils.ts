/**
 * Shared harness for the gateway's WebSocket proxy routes (`/v1/stt/stream`,
 * `/v1/watch/stream`, `/v1/desktop/stream`, `/v1/live-voice`, the speech
 * relay): edge tokens, a gateway config, a fake `Bun.Server` whose `upgrade`
 * result is scripted, and a fake downstream socket that records traffic.
 */

import { mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

/** The bound guardian's actor principal, which `mintEdgeToken` defaults to. */
export const GUARDIAN_PRINCIPAL = "test-user";

/** The bound guardian's platform user id, for the velay-attested path. */
export const VELAY_USER_ID = "11111111-1111-1111-1111-111111111111";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

/** Mint a valid actor edge JWT. */
export function mintEdgeToken(
  actorPrincipalId: string = GUARDIAN_PRINCIPAL,
): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: `actor:test-assistant:${actorPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

/** Mint a service-style token (no actor principal). */
export function mintServiceEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

export function makeConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

export function makeFakeServer(upgradeResult: boolean = true) {
  return {
    requestIP: mock(() => ({
      address: "127.0.0.1",
      family: "IPv4",
      port: 54000,
    })),
    upgrade: mock(() => upgradeResult),
  } as unknown as import("bun").Server<unknown>;
}

/** The socket data the handler asked Bun to attach to the upgraded socket. */
export function upgradedData<T>(server: import("bun").Server<unknown>): T {
  const call = (server.upgrade as ReturnType<typeof mock>).mock
    .calls[0] as unknown[];
  return (call[1] as { data: T }).data;
}

/**
 * A downstream (client-facing) socket that records what it is sent and how
 * it is closed. `sendStatus` is what Bun reports for each send; 0 is a drop.
 */
export function createFakeDownstreamWs<T>(
  data: T,
  options: { sendStatus?: number } = {},
) {
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    data,
    sent,
    closes,
    send: mock((msg: string | Uint8Array) => {
      sent.push(msg);
      return options.sendStatus ?? 1;
    }),
    close: mock((code?: number, reason?: string) => {
      closes.push({ code: code ?? 1000, reason: reason ?? "" });
    }),
  };
}

/** A loopback WebSocket server standing in for the runtime end of a proxy. */
export type FakeRuntime = {
  server: ReturnType<typeof Bun.serve>;
  /** Every frame the pump forwarded upstream, as bytes. */
  received: Uint8Array[];
  /** Resolves with the upstream socket once the pump has dialed in. */
  connected: Promise<import("bun").ServerWebSocket<unknown>>;
  upgradeUrl: () => URL | undefined;
};

/**
 * Start a loopback server posing as the runtime: it records what it is sent
 * and, when given a `banner`, sends that downstream the moment a pump
 * connects. The drop path lives in the pump's upstream message listener, so
 * exercising it needs a real socket on the other end.
 */
export function startFakeRuntime(banner?: string | Uint8Array): FakeRuntime {
  const received: Uint8Array[] = [];
  let upgradeUrl: URL | undefined;
  let resolveConnected!: (ws: import("bun").ServerWebSocket<unknown>) => void;
  const connected = new Promise<import("bun").ServerWebSocket<unknown>>(
    (resolve) => {
      resolveConnected = resolve;
    },
  );
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      upgradeUrl = new URL(req.url);
      if (srv.upgrade(req)) {
        return undefined as never;
      }
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (banner !== undefined) {
          ws.send(banner);
        }
        resolveConnected(ws);
      },
      message(_ws, message) {
        received.push(
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message),
        );
      },
      close() {},
    },
  });
  return { server, received, connected, upgradeUrl: () => upgradeUrl };
}

/** Poll until `predicate` holds, so tests need no fixed sleeps. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Let the pump settle after a frame the fake runtime already delivered, so a
 * test asserting that nothing closed is asserting against a pump that has run.
 */
export async function settle(iterations = 5) {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
