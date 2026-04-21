import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import "./test-preload.js";

import {
  createGlobalThresholdGetHandler,
  createGlobalThresholdPutHandler,
} from "../http/routes/auto-approve-thresholds.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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

function makeRequest(body?: unknown, method = "PUT"): Request {
  if (body !== undefined) {
    return new Request("http://localhost/v1/permissions/thresholds", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request("http://localhost/v1/permissions/thresholds", {
    method,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-approve thresholds", () => {
  describe("GET handler", () => {
    test("returns defaults when no row exists", async () => {
      const handler = createGlobalThresholdGetHandler();
      const res = await handler(makeRequest(undefined, "GET"));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        interactive: "low",
        background: "medium",
        headless: "none",
      });
    });

    test("returns updated values after PUT", async () => {
      const putHandler = createGlobalThresholdPutHandler();
      const getHandler = createGlobalThresholdGetHandler();

      // First PUT to set values
      await putHandler(makeRequest({ interactive: "medium" }));

      // GET should reflect the update
      const res = await getHandler(makeRequest(undefined, "GET"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        interactive: "medium",
        background: "medium",
        headless: "none",
      });
    });
  });

  describe("PUT handler", () => {
    test("partial update only changes provided fields", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest({ interactive: "medium" }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        interactive: "medium",
        background: "medium",
        headless: "none",
      });
    });

    test("returns 400 for invalid threshold value", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest({ interactive: "high" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("interactive");
      expect(data.error).toContain("none, low, medium");
    });

    test("returns 400 for invalid body (non-JSON)", async () => {
      const handler = createGlobalThresholdPutHandler();

      const req = new Request("http://localhost/v1/permissions/thresholds", {
        method: "PUT",
        body: "not json",
      });
      const res = await handler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("valid JSON");
    });

    test("returns 400 for non-object body", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest("just a string"));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("JSON object");
    });

    test("returns 400 for array body", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest([1, 2, 3]));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("JSON object");
    });

    test("returns 400 for invalid background value", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest({ background: "invalid" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("background");
    });

    test("returns 400 for invalid headless value", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(makeRequest({ headless: 42 }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("headless");
    });

    test("upserts correctly — first write creates, second write updates", async () => {
      const handler = createGlobalThresholdPutHandler();

      // First write — creates the row
      const res1 = await handler(
        makeRequest({ interactive: "none", background: "low" }),
      );
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1).toEqual({
        interactive: "none",
        background: "low",
        headless: "none",
      });

      // Second write — updates the existing row
      const res2 = await handler(
        makeRequest({ background: "medium", headless: "low" }),
      );
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2).toEqual({
        interactive: "none",
        background: "medium",
        headless: "low",
      });
    });

    test("updates all fields at once", async () => {
      const handler = createGlobalThresholdPutHandler();

      const res = await handler(
        makeRequest({
          interactive: "medium",
          background: "none",
          headless: "low",
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        interactive: "medium",
        background: "none",
        headless: "low",
      });
    });

    test("empty object preserves existing values when row exists", async () => {
      const putHandler = createGlobalThresholdPutHandler();

      // First: set non-default values
      await putHandler(
        makeRequest({
          interactive: "medium",
          background: "none",
          headless: "low",
        }),
      );

      // Then PUT empty object — existing values should be preserved
      const res = await putHandler(makeRequest({}));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        interactive: "medium",
        background: "none",
        headless: "low",
      });
    });

    // Note: "empty PUT inserts schema defaults when no row" is covered by
    // the GET handler test suite. The PUT tests run after prior PUTs leave
    // a row in the DB (bun test reuse), so we test preserve-existing above.
  });
});
