import { describe, expect, test } from "bun:test";

import {
  decodeOAuthResponseBytes,
  jsonSafeOAuthBody,
} from "./connection.js";

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
]);

describe("decodeOAuthResponseBytes", () => {
  test("parses JSON bodies", () => {
    const raw = Buffer.from(JSON.stringify({ id: "file-123", name: "Doc" }));
    expect(
      decodeOAuthResponseBytes(raw, "application/json; charset=utf-8"),
    ).toEqual({ id: "file-123", name: "Doc" });
  });

  test("returns UTF-8 text for text content types", () => {
    const raw = Buffer.from("hello café", "utf8");
    expect(decodeOAuthResponseBytes(raw, "text/plain; charset=utf-8")).toBe(
      "hello café",
    );
  });

  test("preserves non-ASCII binary bytes instead of UTF-8 replacement characters", () => {
    const body = decodeOAuthResponseBytes(
      PNG_MAGIC,
      "application/octet-stream",
    );
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(Buffer.from(body as Uint8Array).equals(PNG_MAGIC)).toBe(true);
    expect(Buffer.from(body as Uint8Array).includes(0xff)).toBe(true);
  });

  test("treats Google Drive media downloads as raw bytes", () => {
    const body = decodeOAuthResponseBytes(
      PNG_MAGIC,
      "application/pdf",
    );
    expect(Buffer.from(body as Uint8Array).equals(PNG_MAGIC)).toBe(true);
  });

  test("returns null for an empty body", () => {
    expect(decodeOAuthResponseBytes(Buffer.alloc(0), "application/json")).toBe(
      null,
    );
  });
});

describe("jsonSafeOAuthBody", () => {
  test("leaves JSON and text bodies unchanged", () => {
    expect(jsonSafeOAuthBody({ ok: true })).toEqual({ body: { ok: true } });
    expect(jsonSafeOAuthBody("hello")).toEqual({ body: "hello" });
  });

  test("base64-encodes binary buffers for JSON envelopes", () => {
    expect(jsonSafeOAuthBody(PNG_MAGIC)).toEqual({
      body: PNG_MAGIC.toString("base64"),
      bodyEncoding: "base64",
    });
    expect(Buffer.from(PNG_MAGIC.toString("base64"), "base64").equals(PNG_MAGIC)).toBe(
      true,
    );
  });
});
