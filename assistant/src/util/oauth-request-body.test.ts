import { describe, expect, test } from "bun:test";

import {
  findContentTypeHeader,
  isJsonContentType,
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
