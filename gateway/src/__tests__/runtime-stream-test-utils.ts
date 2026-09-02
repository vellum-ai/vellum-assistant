/**
 * Shared harness for the runtime-stream WebSocket proxies (`/v1/stt/stream`,
 * `/v1/watch/stream`, `/v1/desktop/stream`): edge tokens, a gateway config,
 * and a fake `Bun.Server` whose `upgrade` result is scripted.
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
