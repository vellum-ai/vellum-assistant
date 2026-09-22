import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { RuntimeHttpServer } from "../http-server.js";
import {
  mintActorToken,
  mintGatewayToken,
  requireHttpAuth,
  upgradeHeaders,
} from "./runtime-ws-test-utils.js";

describe("Live voice through the shared runtime upgrade", () => {
  let restoreAuth: () => void;
  beforeEach(() => {
    restoreAuth = requireHttpAuth();
  });
  afterEach(() => restoreAuth());

  function upgrade(token: string, guardianPrincipalId?: string) {
    const runtime = new RuntimeHttpServer();
    const server = {
      requestIP: () => ({ address: "127.0.0.1" }),
      upgrade: mock(() => true),
    };
    const query = new URLSearchParams({ token });
    if (guardianPrincipalId !== undefined) {
      query.set("guardianPrincipalId", guardianPrincipalId);
    }
    const response = runtime["handleLiveVoiceUpgrade"](
      new Request(`http://127.0.0.1/v1/live-voice?${query}`, {
        headers: upgradeHeaders,
      }),
      server as unknown as ReturnType<typeof Bun.serve>,
    );
    return { response, server };
  }

  test("forwards the gateway-admitted guardian identity to the session", () => {
    const { response, server } = upgrade(mintGatewayToken(), "user-123");
    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(expect.any(Request), {
      data: { wsType: "live-voice", guardianPrincipalId: "user-123" },
    });
  });

  test("accepts gateway clients without a guardian identity", () => {
    const { response, server } = upgrade(mintGatewayToken());
    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(expect.any(Request), {
      data: { wsType: "live-voice" },
    });
  });

  test("rejects actor tokens even when they supply a guardian identity", () => {
    const { response, server } = upgrade(mintActorToken(), "user-123");
    expect(response?.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});
