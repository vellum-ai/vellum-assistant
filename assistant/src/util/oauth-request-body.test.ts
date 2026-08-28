import { describe, expect, test } from "bun:test";

import {
  findContentTypeHeader,
  isBinaryOAuthContentType,
  isJsonContentType,
  parseRequestBodyBytes,
  parseRequestBodyData,
} from "./oauth-request-body.js";

describe("isJsonContentType", () => {
  test("recognizes application/json with and without parameters", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=UTF-8")).toBe(true);
    expect(isJsonContentType("Application/JSON")).toBe(true);
  });

  test("recognizes structured JSON suffixes", () => {
    expect(isJsonContentType("application/vnd.api+json")).toBe(true);
  });

  test("rejects non-JSON media types and empty values", () => {
    expect(isJsonContentType("multipart/related; boundary=b")).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType("")).toBe(false);
  });
});

describe("findContentTypeHeader", () => {
  test("matches the header in any casing", () => {
    expect(findContentTypeHeader({ "content-type": "text/csv" })).toBe(
      "text/csv",
    );
    expect(findContentTypeHeader({ "Content-Type": "text/csv" })).toBe(
      "text/csv",
    );
    expect(findContentTypeHeader({ "CONTENT-TYPE": "text/csv" })).toBe(
      "text/csv",
    );
  });

  test("returns undefined when absent", () => {
    expect(findContentTypeHeader(undefined)).toBeUndefined();
    expect(
      findContentTypeHeader({ Accept: "application/json" }),
    ).toBeUndefined();
  });
});

describe("parseRequestBodyData", () => {
  test("keeps the raw string under a non-JSON Content-Type", () => {
    expect(parseRequestBodyData('{"a":1}', "multipart/related")).toBe(
      '{"a":1}',
    );
  });

  test("parses under a JSON Content-Type", () => {
    expect(parseRequestBodyData('{"a":1}', "application/json")).toEqual({
      a: 1,
    });
  });

  test("parses when no Content-Type is given", () => {
    expect(parseRequestBodyData('{"a":1}', undefined)).toEqual({ a: 1 });
  });

  test("keeps unparseable text raw when no Content-Type is given", () => {
    expect(parseRequestBodyData("a=1&b=2", undefined)).toBe("a=1&b=2");
  });

  test("keeps a JSON string scalar in its quoted wire form", () => {
    expect(parseRequestBodyData('"hello"', "application/json")).toBe('"hello"');
    expect(parseRequestBodyData('"hello"', undefined)).toBe('"hello"');
  });
});

describe("isBinaryOAuthContentType", () => {
  test("recognizes PDF, octet-stream, and image types", () => {
    expect(isBinaryOAuthContentType("application/pdf")).toBe(true);
    expect(isBinaryOAuthContentType("application/octet-stream")).toBe(true);
    expect(isBinaryOAuthContentType("image/png; charset=binary")).toBe(true);
  });

  test("rejects JSON, multipart, and form types", () => {
    expect(isBinaryOAuthContentType("application/json")).toBe(false);
    expect(isBinaryOAuthContentType("multipart/related; boundary=b")).toBe(
      false,
    );
    expect(isBinaryOAuthContentType("application/x-www-form-urlencoded")).toBe(
      false,
    );
    expect(isBinaryOAuthContentType(undefined)).toBe(false);
  });
});

describe("parseRequestBodyBytes", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe,
  ]);

  test("keeps invalid UTF-8 as a Buffer", () => {
    const parsed = parseRequestBodyBytes(png, "multipart/related; boundary=b");
    expect(Buffer.isBuffer(parsed)).toBe(true);
    expect(Buffer.from(parsed as Uint8Array).equals(png)).toBe(true);
  });

  test("keeps a PDF Content-Type as a Buffer even when the bytes are ASCII", () => {
    const asciiPdf = Buffer.from("%PDF-1.4 simple", "ascii");
    const parsed = parseRequestBodyBytes(asciiPdf, "application/pdf");
    expect(Buffer.isBuffer(parsed)).toBe(true);
    expect(Buffer.from(parsed as Uint8Array).equals(asciiPdf)).toBe(true);
  });

  test("keeps valid UTF-8 multipart as the exact string", () => {
    const multipart = "--b\r\nContent-Type: text/csv\r\n\r\na,b\r\n--b--\r\n";
    expect(
      parseRequestBodyBytes(
        Buffer.from(multipart, "utf-8"),
        "multipart/related; boundary=b",
      ),
    ).toBe(multipart);
  });

  test("parses UTF-8 JSON into an object", () => {
    expect(
      parseRequestBodyBytes(
        Buffer.from('{"name":"Sheet"}', "utf-8"),
        "application/json",
      ),
    ).toEqual({ name: "Sheet" });
  });
});
