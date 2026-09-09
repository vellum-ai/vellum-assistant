import { describe, expect, test } from "bun:test";

import {
  IpcCallError,
  IpcConnectError,
} from "@vellumai/gateway-client/ipc-client";

import {
  RouteError,
  ServiceUnavailableError,
} from "../../runtime/routes/errors.js";
import {
  mapGatewayIpcConnectError,
  rethrowGatewayIpcFailure,
} from "../gateway-ipc-errors.js";

describe("mapGatewayIpcConnectError", () => {
  test("maps IpcConnectError to ServiceUnavailableError", () => {
    const mapped = mapGatewayIpcConnectError(
      new IpcConnectError("connect ENOENT", "ENOENT"),
    );
    expect(mapped).toBeInstanceOf(ServiceUnavailableError);
    expect((mapped as ServiceUnavailableError).statusCode).toBe(503);
    expect((mapped as ServiceUnavailableError).message).toContain(
      "Gateway is not reachable over IPC",
    );
  });

  test("leaves other errors unchanged", () => {
    const err = new Error("boom");
    expect(mapGatewayIpcConnectError(err)).toBe(err);
  });
});

describe("rethrowGatewayIpcFailure", () => {
  test("maps IpcCallError onto RouteError with the gateway status", () => {
    try {
      rethrowGatewayIpcFailure(
        new IpcCallError("Invite not found", {
          statusCode: 404,
          errorCode: "NOT_FOUND",
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(404);
      expect((err as RouteError).code).toBe("NOT_FOUND");
    }
  });
});
