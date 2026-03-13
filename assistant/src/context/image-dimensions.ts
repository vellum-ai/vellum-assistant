/**
 * Parses image dimensions from base64-encoded image data by reading binary headers.
 * Supports PNG, JPEG, GIF, and WebP formats.
 * Returns null if parsing fails for any reason (corrupt, truncated, unrecognized).
 */
export function parseImageDimensions(
  base64Data: string,
  mediaType: string,
): { width: number; height: number } | null {
  try {
    switch (mediaType) {
      case "image/png":
        return parsePng(base64Data);
      case "image/jpeg":
        return parseJpeg(base64Data);
      case "image/gif":
        return parseGif(base64Data);
      case "image/webp":
        return parseWebp(base64Data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function decodeBase64Bytes(
  base64Data: string,
  maxBytes: number,
): Buffer | null {
  // Estimate how much base64 we need: every 4 base64 chars = 3 bytes
  const charsNeeded = Math.ceil((maxBytes * 4) / 3);
  const slice = base64Data.slice(0, charsNeeded + 4); // a little extra for padding
  try {
    const buf = Buffer.from(slice, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function readUint32BE(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return -1;
  return buf.readUInt32BE(offset);
}

function readUint16BE(buf: Buffer, offset: number): number {
  if (offset + 2 > buf.length) return -1;
  return buf.readUInt16BE(offset);
}

function readUint16LE(buf: Buffer, offset: number): number {
  if (offset + 2 > buf.length) return -1;
  return buf.readUInt16LE(offset);
}

function readUint32LE(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return -1;
  return buf.readUInt32LE(offset);
}

function readUint24LE(buf: Buffer, offset: number): number {
  if (offset + 3 > buf.length) return -1;
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16);
}

function parsePng(
  base64Data: string,
): { width: number; height: number } | null {
  const buf = decodeBase64Bytes(base64Data, 32);
  if (!buf || buf.length < 24) return null;

  // Validate PNG signature: 89 50 4E 47
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }

  const width = readUint32BE(buf, 16);
  const height = readUint32BE(buf, 20);
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function parseJpeg(
  base64Data: string,
): { width: number; height: number } | null {
  // Scan up to 1 MiB to handle JPEGs with large EXIF/ICC metadata before the SOF marker
  const buf = decodeBase64Bytes(base64Data, 1_048_576);
  if (!buf || buf.length < 2) return null;

  // Validate JPEG SOI marker
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buf.length - 1) {
    // Find next marker
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }

    // Skip padding 0xFF bytes
    while (offset < buf.length && buf[offset] === 0xff) {
      offset++;
    }
    if (offset >= buf.length) return null;

    const marker = buf[offset]!;
    offset++;

    // Check for SOF markers: C0-CF excluding C4 (DHT) and CC (DAC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xcc
    ) {
      // SOF marker found: skip 2-byte length + 1-byte precision
      if (offset + 7 > buf.length) return null;
      const height = readUint16BE(buf, offset + 3);
      const width = readUint16BE(buf, offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    // Skip this marker's payload
    if (offset + 1 >= buf.length) return null;
    const segmentLength = readUint16BE(buf, offset);
    if (segmentLength < 2) return null;
    offset += segmentLength;
  }

  return null;
}

function parseGif(
  base64Data: string,
): { width: number; height: number } | null {
  const buf = decodeBase64Bytes(base64Data, 12);
  if (!buf || buf.length < 10) return null;

  // Validate GIF signature: 47 49 46 38 (GIF8)
  if (
    buf[0] !== 0x47 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x46 ||
    buf[3] !== 0x38
  ) {
    return null;
  }

  const width = readUint16LE(buf, 6);
  const height = readUint16LE(buf, 8);
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

function parseWebp(
  base64Data: string,
): { width: number; height: number } | null {
  const buf = decodeBase64Bytes(base64Data, 32);
  if (!buf || buf.length < 16) return null;

  // Validate RIFF signature
  if (
    buf[0] !== 0x52 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x46 ||
    buf[3] !== 0x46
  ) {
    return null;
  }
  // Validate WEBP signature at offset 8
  if (
    buf[8] !== 0x57 ||
    buf[9] !== 0x45 ||
    buf[10] !== 0x42 ||
    buf[11] !== 0x50
  ) {
    return null;
  }

  // Identify sub-format at offset 12
  const subFormat =
    String.fromCharCode(buf[12]!) +
    String.fromCharCode(buf[13]!) +
    String.fromCharCode(buf[14]!) +
    String.fromCharCode(buf[15]!);

  if (subFormat === "VP8 ") {
    // VP8 lossy
    if (buf.length < 30) return null;
    const width = readUint16LE(buf, 26) & 0x3fff;
    const height = readUint16LE(buf, 28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  if (subFormat === "VP8L") {
    // VP8L lossless — validate signature byte 0x2f at offset 20
    if (buf.length < 25) return null;
    if (buf[20] !== 0x2f) return null;
    const bits = readUint32LE(buf, 21);
    if (bits < 0) return null;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  if (subFormat === "VP8X") {
    // VP8X extended
    if (buf.length < 30) return null;
    const width = readUint24LE(buf, 24) + 1;
    const height = readUint24LE(buf, 27) + 1;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  return null;
}
