import { describe, expect, test } from "bun:test";

import { extract } from "tar-stream";

import {
  MALFORMED_USTAR_SIZE,
  parseUstarSizeField,
  writeUstarSizeField,
} from "./ustar-size.js";

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

  test("rejects negative and unsafe base-256 sizes", () => {
    const header = new Uint8Array(512);
    header.fill(0xff, 124, 136);
    expect(() => parseUstarSizeField(header)).toThrow(MALFORMED_USTAR_SIZE);
    header[124] = 0x80;
    expect(() => parseUstarSizeField(header)).toThrow(MALFORMED_USTAR_SIZE);
  });
});

describe("writeUstarSizeField", () => {
  test.each([
    0,
    1024,
    8 * 1024 ** 3 - 1,
    8 * 1024 ** 3,
    32 * 1024 ** 3,
    500 * 1024 ** 3,
  ])(
    "tar-stream and the buffered reader both decode a %d-byte file",
    async (size) => {
      const header = new Uint8Array(512);
      header.set(Buffer.from("assistant.db"));
      header[156] = "0".charCodeAt(0);
      header.set(Buffer.from("ustar\0"), 257);
      writeUstarSizeField(header, size);
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.set(
        Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `),
        148,
      );
      expect(parseUstarSizeField(header)).toBe(size);

      // Decode only the header so this covers large files without allocating their bodies.
      const reader = extract();
      try {
        const decoded = new Promise<number>((resolve, reject) => {
          reader.on("error", reject);
          reader.on("entry", (entry, body) => {
            body.on("error", () => {});
            resolve(entry.size);
          });
        });
        reader.write(header);
        expect(await decoded).toBe(size);
      } finally {
        reader.destroy();
      }
    },
  );
});
