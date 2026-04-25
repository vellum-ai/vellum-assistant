/**
 * Tests the trustedSource flag plumbing through handleUploadAttachment.
 * The flag is forwarded by the gateway when a channel actor resolves to
 * a guardian binding; the assistant only honors it when the request is
 * authenticated as a gateway service token.
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

import { initializeDb } from "../memory/db.js";
import type { AuthContext } from "../runtime/auth/types.js";
import { handleUploadAttachment } from "../runtime/routes/attachment-routes.js";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function makeJsonRequest(body: unknown): Request {
  return new Request("http://localhost/v1/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeServiceAuthContext(): AuthContext {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway",
    assistantId: "self",
    actorPrincipalId: undefined,
    scopeProfile: "gateway_service_v1",
    scopes: new Set(),
    policyEpoch: 0,
  } as AuthContext;
}

function makeActorAuthContext(): AuthContext {
  return {
    subject: "actor:self:principal-abc",
    principalType: "actor",
    assistantId: "self",
    actorPrincipalId: "principal-abc",
    scopeProfile: "actor_client_v1",
    scopes: new Set(),
    policyEpoch: 0,
  } as AuthContext;
}

describe("handleUploadAttachment — trustedSource flag", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    // Each test uploads a fresh attachment with unique filename; no per-test
    // cleanup needed since the staging directory is recreated lazily.
  });

  test("svc_gateway + trustedSource:true accepts a non-allowlisted MIME type", async () => {
    const res = await handleUploadAttachment(
      makeJsonRequest({
        filename: "clip.mkv",
        mimeType: "video/x-matroska",
        data: SMALL_PNG_BASE64, // bytes don't have to match the claimed MIME for this path
        trustedSource: true,
      }),
      makeServiceAuthContext(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; mime_type: string };
    expect(body.id).toBeDefined();
    expect(body.mime_type).toBe("video/x-matroska");
  });

  test("svc_gateway + trustedSource:true accepts a dangerous extension", async () => {
    const res = await handleUploadAttachment(
      makeJsonRequest({
        filename: "installer.dmg",
        mimeType: "application/octet-stream",
        data: SMALL_PNG_BASE64,
        trustedSource: true,
      }),
      makeServiceAuthContext(),
    );

    expect(res.status).toBe(200);
  });

  test("actor caller with trustedSource:true is still rejected (gating works)", async () => {
    const res = await handleUploadAttachment(
      makeJsonRequest({
        filename: "clip.mkv",
        mimeType: "video/x-matroska",
        data: SMALL_PNG_BASE64,
        trustedSource: true,
      }),
      makeActorAuthContext(),
    );

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Unsupported MIME type");
  });

  test("svc_gateway without trustedSource keeps existing rejection", async () => {
    const res = await handleUploadAttachment(
      makeJsonRequest({
        filename: "payload.exe",
        mimeType: "application/octet-stream",
        data: SMALL_PNG_BASE64,
      }),
      makeServiceAuthContext(),
    );

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Dangerous file type");
  });
});
