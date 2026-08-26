/**
 * Tests for the pairing-family body-reading helpers in `route-helpers.ts`.
 *
 * Both functions only read the request body, no DB or auth setup needed.
 */

import { describe, expect, test } from "bun:test";

import {
  readJsonStringField,
  readJsonStringFields,
} from "../http/route-helpers.js";

function makeRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://example.com/v1/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const MAX_BYTES = 1024;

describe("readJsonStringFields", () => {
  test("a literal null JSON body returns 400, not a crash", async () => {
    const result = await readJsonStringFields(
      makeRequest("null"),
      MAX_BYTES,
      "deviceCode",
      ["clientReportedName"],
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "invalid JSON body" },
    });
  });

  test("a JSON array body returns the same 400", async () => {
    const result = await readJsonStringFields(
      makeRequest('["deviceCode"]'),
      MAX_BYTES,
      "deviceCode",
      [],
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "invalid JSON body" },
    });
  });

  test("a non-object JSON body (e.g. a bare string or number) returns the same 400", async () => {
    for (const rawBody of ['"just a string"', "42", "true"]) {
      const result = await readJsonStringFields(
        makeRequest(rawBody),
        MAX_BYTES,
        "deviceCode",
        [],
      );

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    }
  });

  test("unparseable JSON returns 400 invalid JSON body", async () => {
    const result = await readJsonStringFields(
      makeRequest("{not json"),
      MAX_BYTES,
      "deviceCode",
      [],
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "invalid JSON body" },
    });
  });

  test("an oversized body returns 413 PAYLOAD_TOO_LARGE", async () => {
    const bodyObj = { deviceCode: "A".repeat(2000) };
    const bodyStr = JSON.stringify(bodyObj);
    const result = await readJsonStringFields(
      makeRequest(bodyStr, { "content-length": String(bodyStr.length) }),
      MAX_BYTES,
      "deviceCode",
      [],
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large" },
    });
  });

  test("a missing required field returns 400 with the field name", async () => {
    const result = await readJsonStringFields(
      makeRequest(JSON.stringify({ clientReportedName: "phone" })),
      MAX_BYTES,
      "deviceCode",
      ["clientReportedName"],
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "deviceCode is required" },
    });
  });

  test("a valid object body extracts the required field and defaults absent optional fields to null", async () => {
    const result = await readJsonStringFields(
      makeRequest(JSON.stringify({ deviceCode: "abc-123" })),
      MAX_BYTES,
      "deviceCode",
      ["clientReportedName"],
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual({
      deviceCode: "abc-123",
      clientReportedName: null,
    });
  });

  test("a valid object body extracts both required and present optional fields", async () => {
    const result = await readJsonStringFields(
      makeRequest(
        JSON.stringify({
          deviceCode: "abc-123",
          clientReportedName: "Alice's iPhone",
        }),
      ),
      MAX_BYTES,
      "deviceCode",
      ["clientReportedName"],
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual({
      deviceCode: "abc-123",
      clientReportedName: "Alice's iPhone",
    });
  });

  test("a non-string optional field defaults to null rather than erroring", async () => {
    const result = await readJsonStringFields(
      makeRequest(
        JSON.stringify({ deviceCode: "abc-123", clientReportedName: 12345 }),
      ),
      MAX_BYTES,
      "deviceCode",
      ["clientReportedName"],
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual({ deviceCode: "abc-123", clientReportedName: null });
  });
});

describe("readJsonStringField (single-field)", () => {
  test("a literal null JSON body returns 400 invalid JSON body", async () => {
    const result = await readJsonStringField(
      makeRequest("null"),
      MAX_BYTES,
      "deviceId",
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "invalid JSON body" },
    });
  });

  test("a JSON array body returns the same 400", async () => {
    const result = await readJsonStringField(
      makeRequest('["deviceId"]'),
      MAX_BYTES,
      "deviceId",
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "invalid JSON body" },
    });
  });

  test("a non-object JSON body (e.g. a bare string or number) returns the same 400", async () => {
    for (const rawBody of ['"just a string"', "42", "true"]) {
      const result = await readJsonStringField(
        makeRequest(rawBody),
        MAX_BYTES,
        "deviceId",
      );

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    }
  });

  test("a valid object body extracts the field", async () => {
    const result = await readJsonStringField(
      makeRequest(JSON.stringify({ deviceId: "device-1" })),
      MAX_BYTES,
      "deviceId",
    );

    expect(result).toBe("device-1");
  });

  test("a missing field returns 400 with the field name", async () => {
    const result = await readJsonStringField(
      makeRequest(JSON.stringify({})),
      MAX_BYTES,
      "deviceId",
    );

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "deviceId is required" },
    });
  });
});
