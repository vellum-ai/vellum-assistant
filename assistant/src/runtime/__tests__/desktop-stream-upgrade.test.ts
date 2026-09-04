import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RuntimeHttpServer } from "../http-server.js";
import {
  mintActorToken,
  mintGatewayToken,
  requireHttpAuth,
  upgradeHeaders,
  waitForClose,
} from "./runtime-ws-test-utils.js";

describe("RuntimeHttpServer /v1/desktop/stream upgrade", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let restoreAuthEnv: () => void;

  beforeEach(async () => {
    restoreAuthEnv = requireHttpAuth();
    const port = 21400 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    await server.stop();
    restoreAuthEnv();
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
