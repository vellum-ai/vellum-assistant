import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { RuntimeHttpServer } from "../http-server.js";
import {
  mintGatewayToken,
  requireHttpAuth,
  upgradeHeaders,
} from "./runtime-ws-test-utils.js";

describe("Watch capture target through the shared runtime upgrade", () => {
  let restoreAuth: () => void;
  beforeEach(() => {
    restoreAuth = requireHttpAuth();
  });
  afterEach(() => restoreAuth());

  function upgrade(params: string) {
    const runtime = new RuntimeHttpServer();
    const server = {
      requestIP: () => ({ address: "127.0.0.1" }),
      upgrade: mock(() => true),
    };
    const response = runtime["handleWatchStreamUpgrade"](
      new Request(
        `http://127.0.0.1/v1/watch/stream?token=${mintGatewayToken()}&mimeType=audio/pcm&sampleRate=16000&${params}`,
        { headers: upgradeHeaders },
      ),
      server as unknown as ReturnType<typeof Bun.serve>,
    );
    return { response, server };
  }

  test.each([
    ["captureWindowId=4242", { kind: "window", windowId: 4242 }],
    ["captureDisplayId=7", { kind: "display", displayId: 7 }],
    ["", undefined],
  ])("preserves the selected target: %s", (params, captureTarget) => {
    const { response, server } = upgrade(params);
    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(expect.any(Request), {
      data: expect.objectContaining({
        wsType: "watch-stream",
        mimeType: "audio/pcm",
        sampleRate: 16000,
        captureTarget,
      }),
    });
  });

  test.each([
    "captureWindowId=abc",
    "captureDisplayId=-1",
    "captureWindowId=1&captureDisplayId=2",
  ])("refuses an invalid target before upgrading: %s", (params) => {
    const { response, server } = upgrade(params);
    expect(response?.status).toBe(400);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});
