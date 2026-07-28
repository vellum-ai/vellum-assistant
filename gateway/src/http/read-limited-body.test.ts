import { describe, expect, test } from "bun:test";
import { readLimitedBody, readLimitedBodyBytes } from "./read-limited-body.js";

function streamBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/**
 * A stream body carries no Content-Length header, mirroring a chunked
 * transfer-encoding request — the case that slips past a header-only guard.
 */
function streamedRequest(chunks: Uint8Array[]): Request {
  return new Request("http://gateway.test/webhook", {
    method: "POST",
    body: streamBody(chunks),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readLimitedBodyBytes", () => {
  test("returns the body bytes when under the cap", async () => {
    const req = new Request("http://gateway.test/webhook", {
      method: "POST",
      body: "hello",
    });
    const result = await readLimitedBodyBytes(req, 1024);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    }
  });

  test("returns ok with empty bytes when there is no body", async () => {
    const req = new Request("http://gateway.test/webhook", { method: "GET" });
    const result = await readLimitedBodyBytes(req, 1024);
    expect(result).toEqual({ status: "ok", bytes: new Uint8Array(0) });
  });

  test("rejects on an oversized Content-Length before reading", async () => {
    const req = new Request("http://gateway.test/webhook", {
      method: "POST",
      body: "x".repeat(100),
      headers: { "content-length": "100" },
    });
    const result = await readLimitedBodyBytes(req, 10);
    expect(result.status).toBe("too_large");
  });

  test("caps a streamed body with no Content-Length as bytes accumulate", async () => {
    const chunk = new Uint8Array(8);
    const req = streamedRequest([chunk, chunk, chunk]); // 24 bytes
    expect(req.headers.get("content-length")).toBeNull();
    const result = await readLimitedBodyBytes(req, 16);
    expect(result.status).toBe("too_large");
  });

  test("accepts a streamed body that stays within the cap", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const req = streamedRequest([chunk, chunk]); // 8 bytes
    const result = await readLimitedBodyBytes(req, 16);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.bytes.byteLength).toBe(8);
    }
  });
});

describe("readLimitedBody", () => {
  test("decodes a within-cap body to text", async () => {
    const req = new Request("http://gateway.test/webhook", {
      method: "POST",
      body: "abc",
    });
    const result = await readLimitedBody(req, 1024);
    expect(result).toEqual({ status: "ok", text: "abc" });
  });

  test("propagates too_large from the streamed byte cap", async () => {
    const chunk = new Uint8Array(8);
    const result = await readLimitedBody(streamedRequest([chunk, chunk]), 4);
    expect(result.status).toBe("too_large");
  });
});
