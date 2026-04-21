import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import {
  createConversationThresholdGetHandler,
  createConversationThresholdPutHandler,
  createConversationThresholdDeleteHandler,
} from "../http/routes/auto-approve-thresholds.js";

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://gateway.test";

function makeGet(conversationId: string): [Request, string[]] {
  return [
    new Request(
      `${BASE_URL}/v1/permissions/thresholds/conversations/${conversationId}`,
      { method: "GET" },
    ),
    [conversationId],
  ];
}

function makePut(conversationId: string, body: unknown): [Request, string[]] {
  return [
    new Request(
      `${BASE_URL}/v1/permissions/thresholds/conversations/${conversationId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    [conversationId],
  ];
}

function makeDelete(conversationId: string): [Request, string[]] {
  return [
    new Request(
      `${BASE_URL}/v1/permissions/thresholds/conversations/${conversationId}`,
      { method: "DELETE" },
    ),
    [conversationId],
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/permissions/thresholds/conversations/:conversationId", () => {
  test("returns 404 for nonexistent conversation", async () => {
    const handler = createConversationThresholdGetHandler();
    const [req, params] = makeGet("conv-xyz");

    const res = await handler(req, params);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("No override for this conversation");
  });

  test("returns threshold after PUT creates it", async () => {
    const putHandler = createConversationThresholdPutHandler();
    const getHandler = createConversationThresholdGetHandler();

    // Create the override
    const [putReq, putParams] = makePut("conv-xyz", { threshold: "medium" });
    const putRes = await putHandler(putReq, putParams);
    expect(putRes.status).toBe(200);

    // Read it back
    const [getReq, getParams] = makeGet("conv-xyz");
    const getRes = await getHandler(getReq, getParams);
    expect(getRes.status).toBe(200);

    const body = await getRes.json();
    expect(body.threshold).toBe("medium");
  });
});

describe("PUT /v1/permissions/thresholds/conversations/:conversationId", () => {
  test("creates override and returns conversationId + threshold", async () => {
    const handler = createConversationThresholdPutHandler();
    const [req, params] = makePut("conv-abc", { threshold: "low" });

    const res = await handler(req, params);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ conversationId: "conv-abc", threshold: "low" });
  });

  test("updates existing override with new value", async () => {
    const handler = createConversationThresholdPutHandler();
    const getHandler = createConversationThresholdGetHandler();

    // Create initial
    const [req1, params1] = makePut("conv-abc", { threshold: "low" });
    await handler(req1, params1);

    // Update
    const [req2, params2] = makePut("conv-abc", { threshold: "none" });
    const res = await handler(req2, params2);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ conversationId: "conv-abc", threshold: "none" });

    // Verify via GET
    const [getReq, getParams] = makeGet("conv-abc");
    const getRes = await getHandler(getReq, getParams);
    const getBody = await getRes.json();
    expect(getBody.threshold).toBe("none");
  });

  test("returns 400 for invalid threshold", async () => {
    const handler = createConversationThresholdPutHandler();
    const [req, params] = makePut("conv-abc", { threshold: "invalid" });

    const res = await handler(req, params);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("threshold");
  });

  test("returns 400 for missing threshold", async () => {
    const handler = createConversationThresholdPutHandler();
    const [req, params] = makePut("conv-abc", {});

    const res = await handler(req, params);
    expect(res.status).toBe(400);
  });

  test("returns 400 for non-JSON body", async () => {
    const handler = createConversationThresholdPutHandler();
    const req = new Request(
      `${BASE_URL}/v1/permissions/thresholds/conversations/conv-abc`,
      {
        method: "PUT",
        body: "not json",
      },
    );

    const res = await handler(req, ["conv-abc"]);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/permissions/thresholds/conversations/:conversationId", () => {
  test("removes existing override, subsequent GET returns 404", async () => {
    const putHandler = createConversationThresholdPutHandler();
    const getHandler = createConversationThresholdGetHandler();
    const deleteHandler = createConversationThresholdDeleteHandler();

    // Create
    const [putReq, putParams] = makePut("conv-del", { threshold: "medium" });
    await putHandler(putReq, putParams);

    // Delete
    const [delReq, delParams] = makeDelete("conv-del");
    const delRes = await deleteHandler(delReq, delParams);
    expect(delRes.status).toBe(204);

    // Verify gone
    const [getReq, getParams] = makeGet("conv-del");
    const getRes = await getHandler(getReq, getParams);
    expect(getRes.status).toBe(404);
  });

  test("returns 204 on nonexistent conversation (idempotent)", async () => {
    const handler = createConversationThresholdDeleteHandler();
    const [req, params] = makeDelete("conv-nonexistent");

    const res = await handler(req, params);
    expect(res.status).toBe(204);
  });
});
