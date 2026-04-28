/**
 * Tests the trustedSource flag plumbing through the attachment upload route.
 * The flag is forwarded by the gateway when a channel actor resolves to
 * a guardian binding; the assistant only honors it when the request
 * carries the x-vellum-principal-type: svc_gateway header (injected by
 * the HTTP adapter from AuthContext).
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getAssistantDomain: () => "vellum.me",
}));

import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/attachment-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const uploadRoute = ROUTES.find((r) => r.operationId === "attachment_upload")!;

function makeUploadArgs(
  body: Record<string, unknown>,
  principalType: string,
): RouteHandlerArgs {
  const jsonBody = JSON.stringify(body);
  return {
    body,
    rawBody: new TextEncoder().encode(jsonBody),
    headers: {
      "content-type": "application/json",
      "x-vellum-principal-type": principalType,
    },
    queryParams: {},
  };
}

describe("attachment upload — trustedSource flag", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    // Each test uploads a fresh attachment with unique filename; no per-test
    // cleanup needed since the staging directory is recreated lazily.
  });

  test("svc_gateway + trustedSource:true accepts a non-allowlisted MIME type", async () => {
    const result = (await uploadRoute.handler(
      makeUploadArgs(
        {
          filename: "clip.mkv",
          mimeType: "video/x-matroska",
          data: SMALL_PNG_BASE64,
          trustedSource: true,
        },
        "svc_gateway",
      ),
    )) as Response;

    expect(result.status).toBe(200);
    const body = (await result.json()) as { id: string; mime_type: string };
    expect(body.id).toBeDefined();
    expect(body.mime_type).toBe("video/x-matroska");
  });

  test("svc_gateway + trustedSource:true accepts a dangerous extension", async () => {
    const result = (await uploadRoute.handler(
      makeUploadArgs(
        {
          filename: "installer.dmg",
          mimeType: "application/octet-stream",
          data: SMALL_PNG_BASE64,
          trustedSource: true,
        },
        "svc_gateway",
      ),
    )) as Response;

    expect(result.status).toBe(200);
  });

  test("actor caller with trustedSource:true is still rejected (gating works)", async () => {
    const result = (await uploadRoute.handler(
      makeUploadArgs(
        {
          filename: "clip.mkv",
          mimeType: "video/x-matroska",
          data: SMALL_PNG_BASE64,
          trustedSource: true,
        },
        "actor",
      ),
    )) as Response;

    expect(result.status).toBe(415);
    const body = (await result.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Unsupported MIME type");
  });

  test("svc_gateway without trustedSource keeps existing rejection", async () => {
    const result = (await uploadRoute.handler(
      makeUploadArgs(
        {
          filename: "payload.exe",
          mimeType: "application/octet-stream",
          data: SMALL_PNG_BASE64,
        },
        "svc_gateway",
      ),
    )) as Response;

    expect(result.status).toBe(415);
    const body = (await result.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Dangerous file type");
  });
});
