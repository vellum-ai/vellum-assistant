import { crc32, inflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { desktopScreenshot } from "./desktop-screenshot.js";

type Color = {
  pixel: number;
  red: number;
  green: number;
  blue: number;
  flags: number;
};

function fixture(littleEndian: boolean, colors?: Color[]) {
  const headerSize = 103;
  const offset = headerSize + (colors?.length ?? 0) * 12;
  const xwd = Buffer.alloc(offset + 24);
  const fields = [
    headerSize,
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
    colors ? 5 : 4,
    0xff0000,
    0xff00,
    0xff,
    8,
    256,
    colors?.length ?? 0,
  ];
  fields.forEach((value, i) => xwd.writeUInt32BE(value, i * 4));
  colors?.forEach((color, index) => {
    const entry = headerSize + index * 12;
    xwd.writeUInt32BE(color.pixel, entry);
    xwd.writeUInt16BE(color.red, entry + 4);
    xwd.writeUInt16BE(color.green, entry + 6);
    xwd.writeUInt16BE(color.blue, entry + 8);
    xwd[entry + 10] = color.flags;
  });
  for (const [relativeOffset, pixel] of [
    [0, 0xff0000],
    [4, 0x00ff00],
    [12, 0x0000ff],
    [16, 0xffffff],
  ]) {
    if (littleEndian) {
      xwd.writeUInt32LE(pixel!, offset + relativeOffset!);
    } else {
      xwd.writeUInt32BE(pixel!, offset + relativeOffset!);
    }
  }
  return xwd;
}

function scanlines(png: Buffer): number[] {
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
  return [...inflateSync(Buffer.concat(data))];
}

describe("desktop XWD screenshots", () => {
  test.each([true, false])(
    "encodes RGB pixels and padded rows into valid PNG chunks (little endian: %s)",
    (littleEndian) => {
      const { png, width, height } = desktopScreenshot(fixture(littleEndian));
      expect([width, height]).toEqual([2, 2]);
      expect(scanlines(png)).toEqual([
        0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255,
      ]);
    },
  );

  test.each([true, false])(
    "decodes DirectColor channel maps and component flags (little endian: %s)",
    (littleEndian) => {
      const colors = [
        { pixel: 0xff0000, red: 0x1234, green: 0xffff, blue: 0xffff, flags: 1 },
        { pixel: 0x00ff00, red: 0xffff, green: 0x5678, blue: 0xffff, flags: 2 },
        { pixel: 0x0000ff, red: 0xffff, green: 0xffff, blue: 0x9abc, flags: 4 },
      ];
      const { png } = desktopScreenshot(fixture(littleEndian, colors));
      expect(scanlines(png)).toEqual([
        0, 18, 0, 0, 0, 86, 0, 0, 0, 0, 154, 18, 86, 154,
      ]);
    },
  );

  test("decodes DirectColor with a single color entry and an unaligned header", () => {
    const { png } = desktopScreenshot(
      fixture(true, [{ pixel: 0, red: 0, green: 0, blue: 0, flags: 7 }]),
    );
    expect(scanlines(png)).toEqual([
      0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
  });

  test("rejects truncated pixels, unsupported formats and unbounded dimensions", () => {
    expect(() => desktopScreenshot(Buffer.alloc(10))).toThrow("Incomplete");
    expect(() => desktopScreenshot(fixture(true).subarray(0, 110))).toThrow(
      "Unsupported",
    );
    const bad = fixture(true);
    bad.writeUInt32BE(0xffffffff, 16);
    expect(() => desktopScreenshot(bad)).toThrow("Unsupported");
    const palette = fixture(true);
    palette.writeUInt32BE(3, 13 * 4);
    expect(() => desktopScreenshot(palette)).toThrow("visual=3");
    const truncatedColors = fixture(true, []);
    truncatedColors.writeUInt32BE(256, 19 * 4);
    expect(() => desktopScreenshot(truncatedColors)).toThrow("Unsupported");
  });
});
