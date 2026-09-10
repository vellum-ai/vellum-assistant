import { crc32, inflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { desktopScreenshot } from "./desktop-screenshot.js";

function fixture(littleEndian: boolean) {
  const xwd = Buffer.alloc(132);
  const fields = [
    104,
    7,
    2,
    24,
    2,
    2,
    0,
    littleEndian ? 0 : 1,
    32,
    0,
    32,
    32,
    12,
    4,
    0xff0000,
    0xff00,
    0xff,
    8,
    256,
    0,
  ];
  fields.forEach((value, i) => xwd.writeUInt32BE(value, i * 4));
  for (const [offset, pixel] of [
    [104, 0xff0000],
    [108, 0x00ff00],
    [116, 0x0000ff],
    [120, 0xffffff],
  ]) {
    if (littleEndian) {
      xwd.writeUInt32LE(pixel!, offset!);
    } else {
      xwd.writeUInt32BE(pixel!, offset!);
    }
  }
  return xwd;
}

describe("desktop XWD screenshots", () => {
  test.each([true, false])(
    "encodes RGB pixels and padded rows into valid PNG chunks (little endian: %s)",
    (littleEndian) => {
      const { png, width, height } = desktopScreenshot(fixture(littleEndian));
      expect([width, height]).toEqual([2, 2]);
      let offset = 8;
      const data: Buffer[] = [];
      while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString("ascii", offset + 4, offset + 8);
        expect(png.readUInt32BE(offset + 8 + length)).toBe(
          crc32(png.subarray(offset + 4, offset + 8 + length)),
        );
        if (type === "IDAT") {
          data.push(png.subarray(offset + 8, offset + 8 + length));
        }
        offset += length + 12;
      }
      expect([...inflateSync(Buffer.concat(data))]).toEqual([
        0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255,
      ]);
    },
  );

  test("rejects truncated pixels, unsupported formats and unbounded dimensions", () => {
    expect(() => desktopScreenshot(Buffer.alloc(10))).toThrow("Incomplete");
    expect(() => desktopScreenshot(fixture(true).subarray(0, 110))).toThrow(
      "Unsupported",
    );
    const bad = fixture(true);
    bad.writeUInt32BE(0xffffffff, 16);
    expect(() => desktopScreenshot(bad)).toThrow("Unsupported");
  });
});
