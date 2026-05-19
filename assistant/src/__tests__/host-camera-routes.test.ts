import { beforeEach, describe, expect, mock, test } from "bun:test";

interface PendingEntry {
  conversationId: string;
  kind: string;
  targetClientId?: string;
  targetActorPrincipalId?: string;
}

const pending = new Map<string, PendingEntry>();

mock.module("../runtime/pending-interactions.js", () => ({
  get: (requestId: string) => pending.get(requestId),
  resolve: (requestId: string) => {
    const entry = pending.get(requestId);
    if (entry) pending.delete(requestId);
    return entry;
  },
}));

interface FakeConversation {
  conversationId: string;
  hostCameraProxy?: {
    resolve: (requestId: string, payload: unknown) => void;
  };
}

const conversations = new Map<string, FakeConversation>();

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: (id: string) => conversations.get(id),
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveActorPrincipalIdForLocalGuardian: (value: string | undefined) => value,
}));

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-camera-routes.js";

const handleHostCameraResult = ROUTES.find(
  (r) => r.endpoint === "host-camera-result",
)!.handler;

describe("handleHostCameraResult", () => {
  beforeEach(() => {
    pending.clear();
    conversations.clear();
  });

  test("forwards one-shot image payload to the conversation hostCameraProxy", async () => {
    const requestId = "camera-req-1";
    const conversationId = "conv-1";
    pending.set(requestId, { conversationId, kind: "host_camera" });

    const resolveCalls: Array<{ requestId: string; payload: unknown }> = [];
    conversations.set(conversationId, {
      conversationId,
      hostCameraProxy: {
        resolve(rid, payload) {
          resolveCalls.push({ requestId: rid, payload });
        },
      },
    });

    const result = await handleHostCameraResult({
      body: {
        requestId,
        imageBase64: "jpeg-bytes",
        mediaType: "image/jpeg",
        width: 640,
        height: 480,
      },
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveCalls).toEqual([
      {
        requestId,
        payload: {
          requestId,
          imageBase64: "jpeg-bytes",
          mediaType: "image/jpeg",
          width: 640,
          height: 480,
        },
      },
    ]);
    expect(pending.has(requestId)).toBe(false);
  });

  test("forwards errors without requiring image bytes", async () => {
    const requestId = "camera-req-error";
    const conversationId = "conv-error";
    pending.set(requestId, { conversationId, kind: "host_camera" });

    let payload: unknown;
    conversations.set(conversationId, {
      conversationId,
      hostCameraProxy: {
        resolve(_rid, value) {
          payload = value;
        },
      },
    });

    await handleHostCameraResult({
      body: { requestId, error: "Camera permission denied." },
    });

    expect(payload).toEqual({
      requestId,
      error: "Camera permission denied.",
    });
  });

  test("rejects missing request id", () => {
    expect(() => handleHostCameraResult({ body: {} })).toThrow(BadRequestError);
  });

  test("rejects unknown pending interaction", () => {
    expect(() =>
      handleHostCameraResult({ body: { requestId: "missing" } }),
    ).toThrow(NotFoundError);
  });

  test("rejects wrong pending interaction kind", () => {
    pending.set("req", { conversationId: "conv", kind: "host_file" });
    expect(() =>
      handleHostCameraResult({ body: { requestId: "req" } }),
    ).toThrow(ConflictError);
    expect(pending.has("req")).toBe(true);
  });

  test("targeted result must come from the target client actor", () => {
    pending.set("req", {
      conversationId: "conv",
      kind: "host_camera",
      targetClientId: "client-1",
      targetActorPrincipalId: "actor-1",
    });
    expect(() =>
      handleHostCameraResult({
        body: { requestId: "req", error: "denied" },
        headers: {
          "x-vellum-client-id": "client-1",
          "x-vellum-actor-principal-id": "actor-2",
        },
      }),
    ).toThrow(ForbiddenError);
  });
});
