import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { mintToken } from "../auth/token-service.js";
import { RuntimeHttpServer } from "../http-server.js";

const savedAuthEnv = process.env.DISABLE_HTTP_AUTH;

function mintGatewayToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function mintActorToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:user-123",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

const upgradeHeaders = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

function waitForClose(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for close")),
      2000,
    );
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe("RuntimeHttpServer /v1/desktop/stream upgrade", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    delete process.env.DISABLE_HTTP_AUTH;
    const port = 21400 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    await server.stop();
    if (savedAuthEnv === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = savedAuthEnv;
    }
  });

  test("refuses a non-private origin with 403", async () => {
    const res = await fetch(
      `http://${baseUrl}/v1/desktop/stream?token=${mintGatewayToken()}`,
      {
        headers: { ...upgradeHeaders, Origin: "https://external.example.com" },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "Direct desktop stream access disabled",
    );
  });

  test("refuses a missing or non-gateway token with 401", async () => {
    const missing = await fetch(`http://${baseUrl}/v1/desktop/stream`, {
      headers: upgradeHeaders,
    });
    expect(missing.status).toBe(401);

    const actor = await fetch(
      `http://${baseUrl}/v1/desktop/stream?token=${mintActorToken()}`,
      { headers: upgradeHeaders },
    );
    expect(actor.status).toBe(401);
  });

  test("upgrades a gateway request and reports the feature gate as close code 4008", async () => {
    // The test daemon is not containerized, so the socket opens and is then
    // closed by the desktop-stream open handler rather than refused pre-upgrade.
    const ws = new WebSocket(
      `ws://${baseUrl}/v1/desktop/stream?token=${encodeURIComponent(mintGatewayToken())}`,
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4008);
    expect(closed.reason).toBe("Desktop is not available on this assistant");
  });
});
