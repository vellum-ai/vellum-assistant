import { describe, expect, test } from "bun:test";

import { MALFORMED_USTAR_SIZE, parseUstarSizeField } from "./ustar-size.js";

function headerWithSize(field: string): Uint8Array {
  const header = new Uint8Array(512);
  const bytes = Buffer.from(field, "utf-8");
  header.set(bytes.subarray(0, 12), 124);
  return header;
}

describe("parseUstarSizeField", () => {
  test("reads a NUL-terminated octal size", () => {
    expect(parseUstarSizeField(headerWithSize("00000001000\0"))).toBe(512);
  });

  test("treats an empty field as zero", () => {
    expect(parseUstarSizeField(headerWithSize("\0".repeat(12)))).toBe(0);
  });

  test("rejects a negative octal size", () => {
    expect(() => parseUstarSizeField(headerWithSize("-0000001000\0"))).toThrow(
      MALFORMED_USTAR_SIZE,
    );
  });

  test("rejects a truncated header", () => {
    expect(() => parseUstarSizeField(new Uint8Array(100))).toThrow(
      MALFORMED_USTAR_SIZE,
    );
  });
});
