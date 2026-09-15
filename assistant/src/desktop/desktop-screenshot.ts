import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** Decode 24-bit TrueColor and DirectColor XWD screenshots. */
export function desktopScreenshot(xwd: Buffer): {
  png: Buffer;
  width: number;
  height: number;
} {
  if (xwd.length < 100) {
    throw new Error("Incomplete desktop screenshot");
  }
  const field = (index: number) => xwd.readUInt32BE(index * 4);
  const width = field(4);
  const height = field(5);
  const bitsPerPixel = field(11);
  const bytesPerPixel = bitsPerPixel / 8;
  const stride = field(12);
  const visualClass = field(13);
  const offset = field(0) + field(19) * 12;
  if (
    field(1) !== 7 ||
    field(2) !== 2 ||
    field(3) !== 24 ||
    (bitsPerPixel !== 24 && bitsPerPixel !== 32) ||
    (visualClass !== 4 && visualClass !== 5) ||
    field(6) !== 0 ||
    field(7) > 1 ||
    field(14) !== 0xff0000 ||
    field(15) !== 0xff00 ||
    field(16) !== 0xff ||
    width === 0 ||
    height === 0 ||
    width * height > 4_194_304 ||
    field(0) < 100 ||
    stride < width * bytesPerPixel ||
    offset + stride * height > xwd.length
  ) {
    throw new Error(
      `Unsupported desktop screenshot layout (visual=${visualClass}, depth=${field(3)}, bitsPerPixel=${bitsPerPixel}, size=${width}x${height}, stride=${stride}, bytes=${xwd.length})`,
    );
  }
  const littleEndian = field(7) === 0;
  const redOffset = littleEndian ? 2 : bytesPerPixel - 3;
  const greenOffset = littleEndian ? 1 : bytesPerPixel - 2;
  const blueOffset = littleEndian ? 0 : bytesPerPixel - 1;
  const red = Uint8Array.from({ length: 256 }, (_, value) => value);
  const green = red.slice();
  const blue = red.slice();
  if (visualClass === 5) {
    // DirectColor maps each channel separately; absent entries retain linear RGB.
    for (let entry = field(0); entry < offset; entry += 12) {
      const pixel = xwd.readUInt32BE(entry);
      const flags = xwd[entry + 10]!;
      if (flags & 1) {
        red[(pixel >>> 16) & 0xff] = Math.round(
          xwd.readUInt16BE(entry + 4) / 257,
        );
      }
      if (flags & 2) {
        green[(pixel >>> 8) & 0xff] = Math.round(
          xwd.readUInt16BE(entry + 6) / 257,
        );
      }
      if (flags & 4) {
        blue[pixel & 0xff] = Math.round(xwd.readUInt16BE(entry + 8) / 257);
      }
    }
  }
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    let dest = y * (width * 3 + 1) + 1;
    for (let x = 0; x < width; x++) {
      const source = offset + y * stride + x * bytesPerPixel;
      scanlines[dest++] = red[xwd[source + redOffset]!]!;
      scanlines[dest++] = green[xwd[source + greenOffset]!]!;
      scanlines[dest++] = blue[xwd[source + blueOffset]!]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return {
    width,
    height,
    png: Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(scanlines)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}
