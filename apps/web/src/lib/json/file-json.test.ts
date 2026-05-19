/**
 * Tests for `file-json` helpers — the pure functions that decide whether a
 * file should be rendered as JSON and pretty-print its content.
 *
 * The mime-parameter case (`application/json;charset=utf-8`) is the bug that
 * originally motivated this helper: servers commonly attach `charset` to the
 * mime type, and strict equality against `"application/json"` would let JSON
 * files fall through to the binary-file placeholder.
 */

import { describe, expect, test } from "bun:test";

import { isJson, prettifyJson } from "@/lib/json/file-json.js";

describe("isJson", () => {
  test("matches application/json mime type", () => {
    expect(isJson("anything", "application/json")).toBe(true);
  });

  test("matches application/json with a charset parameter", () => {
    expect(isJson("config.json", "application/json;charset=utf-8")).toBe(true);
    expect(isJson("config.json", "application/json; charset=utf-8")).toBe(true);
  });

  test("matches .json extension regardless of casing", () => {
    expect(isJson("package.json", undefined)).toBe(true);
    expect(isJson("Config.JSON", undefined)).toBe(true);
  });

  test("rejects other extensions and unknown mime types", () => {
    expect(isJson("script.ts", undefined)).toBe(false);
    expect(isJson("notes.md", "text/markdown")).toBe(false);
    expect(isJson(undefined, undefined)).toBe(false);
  });

  test("does not match line-delimited variants — scope is single-document JSON", () => {
    // jsonl / ndjson are streams of JSON documents; pretty-printing them with
    // JSON.parse would fail on the second line. Excluded by design.
    expect(isJson("logs.jsonl", undefined)).toBe(false);
    expect(isJson("events.ndjson", undefined)).toBe(false);
  });
});

describe("prettifyJson", () => {
  test("indents minified JSON with 2 spaces", () => {
    const input = '{"a":1,"b":[2,3]}';
    expect(prettifyJson(input)).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  test("re-formats an already-pretty document consistently", () => {
    const input = '{\n    "a": 1\n}';
    expect(prettifyJson(input)).toBe('{\n  "a": 1\n}');
  });

  test("returns the raw content unchanged when the input does not parse", () => {
    const input = "{ not valid json";
    expect(prettifyJson(input)).toBe(input);
  });

  test("returns the raw content for an empty string (which does not parse)", () => {
    expect(prettifyJson("")).toBe("");
  });
});
