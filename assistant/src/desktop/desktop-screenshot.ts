import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** Decode the 24-bit TrueColor XWD produced by our X server. */
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
  const stride = field(12);
  const offset = field(0) + field(19) * 12;
  if (
    field(1) !== 7 ||
    field(2) !== 2 ||
    field(3) !== 24 ||
    field(11) !== 32 ||
    field(13) !== 4 ||
    field(6) !== 0 ||
    field(7) > 1 ||
    field(14) !== 0xff0000 ||
    field(15) !== 0xff00 ||
    field(16) !== 0xff ||
    width === 0 ||
    height === 0 ||
    width * height > 4_194_304 ||
    field(0) < 100 ||
    stride < width * 4 ||
    offset + stride * height > xwd.length
  ) {
    throw new Error("Unsupported desktop screenshot layout");
  }
  const littleEndian = field(7) === 0;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    let dest = y * (width * 3 + 1) + 1;
    for (let x = 0; x < width; x++) {
      const source = offset + y * stride + x * 4;
      scanlines[dest++] = xwd[source + (littleEndian ? 2 : 1)]!;
      scanlines[dest++] = xwd[source + (littleEndian ? 1 : 2)]!;
      scanlines[dest++] = xwd[source + (littleEndian ? 0 : 3)]!;
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
