/**
 * Unit tests for the IPC error envelope built from `RouteError` instances.
 *
 * Asserts that `AssistantIpcServer.buildErrorResponse` forwards the full
 * `RouteError` shape — including the `details` field — into the IPC response
 * envelope so IPC clients (e.g. gateway→daemon) receive the same structured
 * payload as HTTP clients (e.g. `version_incompatible` migration imports).
 */

import { describe, expect, test } from "bun:test";

import {
  RouteError,
  UnprocessableEntityError,
} from "../../runtime/routes/errors.js";
import { AssistantIpcServer, type IpcResponse } from "../assistant-server.js";

/**
 * `buildErrorResponse` is private; access it through an interface cast so the
 * test exercises the actual production code path without exporting a
 * test-only API on the server class.
 */
type PrivateApi = {
  buildErrorResponse(id: string, err: unknown): IpcResponse;
};

function buildErrorResponse(err: unknown): IpcResponse {
  const server = new AssistantIpcServer() as unknown as PrivateApi;
  return server.buildErrorResponse("req-1", err);
}

describe("AssistantIpcServer error envelope", () => {
  test("forwards RouteError message, statusCode, and code", () => {
    const err = new RouteError("boom", "BOOM", 418);
    const response = buildErrorResponse(err);

    expect(response.id).toBe("req-1");
    expect(response.error).toBe("boom");
    expect(response.statusCode).toBe(418);
    expect(response.errorCode).toBe("BOOM");
    expect(response.errorDetails).toBeUndefined();
  });

  test("forwards RouteError.details into errorDetails when present", () => {
    const details = {
      reason: "version_incompatible" as const,
      bundle_compat: { engineMin: "0.7.0" },
      runtime_version: "0.6.0",
    };
    const err = new UnprocessableEntityError(
      "incompatible bundle version",
      details,
    );

    const response = buildErrorResponse(err);

    expect(response.errorCode).toBe("UNPROCESSABLE_ENTITY");
    expect(response.statusCode).toBe(422);
    expect(response.errorDetails).toEqual(details);
  });

  test("omits errorDetails when RouteError has no details", () => {
    const err = new UnprocessableEntityError("plain validation failure");

    const response = buildErrorResponse(err);

    expect(response.errorCode).toBe("UNPROCESSABLE_ENTITY");
    // `errorDetails` must be omitted entirely (not `undefined` value) so the
    // serialized JSON envelope stays minimal.
    expect("errorDetails" in response).toBe(false);
  });

  test("non-RouteError errors are stringified into `error`", () => {
    const response = buildErrorResponse(new Error("raw"));

    expect(response.error).toBe("Error: raw");
    expect(response.errorCode).toBeUndefined();
    expect(response.errorDetails).toBeUndefined();
  });
});
