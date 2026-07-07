import { describe, expect, test } from "bun:test";

import {
  hasInteriorWhitespace,
  normalizeSecretValue,
} from "../secret-normalize.js";

const PEM_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
  "abcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMN",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("normalizeSecretValue", () => {
  test("trims a trailing newline", () => {
    expect(normalizeSecretValue("sk-ant-oat01-token\n")).toBe(
      "sk-ant-oat01-token",
    );
  });

  test("trims a trailing CRLF", () => {
    expect(normalizeSecretValue("sk-ant-oat01-token\r\n")).toBe(
      "sk-ant-oat01-token",
    );
  });

  test("trims leading spaces", () => {
    expect(normalizeSecretValue("  sk-ant-oat01-token")).toBe(
      "sk-ant-oat01-token",
    );
  });

  test("trims tabs and mixed edge whitespace", () => {
    expect(normalizeSecretValue("\t sk-ant-oat01-token \r\n")).toBe(
      "sk-ant-oat01-token",
    );
  });

  test("preserves interior whitespace in multi-line PEM keys", () => {
    expect(normalizeSecretValue(PEM_KEY)).toBe(PEM_KEY);
  });

  test("edge-trims a PEM key without touching interior newlines", () => {
    expect(normalizeSecretValue(`${PEM_KEY}\n`)).toBe(PEM_KEY);
  });

  test("returns already-clean values unchanged", () => {
    expect(normalizeSecretValue("sk-ant-oat01-token")).toBe(
      "sk-ant-oat01-token",
    );
  });

  test("is idempotent", () => {
    const once = normalizeSecretValue(" token \n");
    expect(normalizeSecretValue(once)).toBe(once);
  });

  test("trims whitespace-only values to empty string", () => {
    expect(normalizeSecretValue("  \r\n\t ")).toBe("");
  });

  test("trims empty string to empty string", () => {
    expect(normalizeSecretValue("")).toBe("");
  });
});

describe("hasInteriorWhitespace", () => {
  test("false for a clean API token", () => {
    expect(hasInteriorWhitespace("sk-ant-oat01-token")).toBe(false);
  });

  test("true for a normalized PEM key", () => {
    expect(hasInteriorWhitespace(normalizeSecretValue(PEM_KEY))).toBe(true);
  });

  test("true for a value with an interior space", () => {
    expect(hasInteriorWhitespace("part-one part-two")).toBe(true);
  });

  test("false for empty string", () => {
    expect(hasInteriorWhitespace("")).toBe(false);
  });
});
