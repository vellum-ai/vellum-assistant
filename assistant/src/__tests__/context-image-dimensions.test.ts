import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { parseImageDimensions } from "../context/image-dimensions.js";

/**
 * Helper: build a Buffer of given bytes and return its base64 encoding.
 */
function toBase64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Minimal valid PNG IHDR: 8-byte signature + 13-byte IHDR chunk.
 * Width = 320, Height = 240.
 */
function minimalPngHeader(width: number, height: number): number[] {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // IHDR chunk: length (13 = 0x0000000D), "IHDR", width(4), height(4), bitDepth, colorType, compression, filter, interlace
  const ihdrLength = [0x00, 0x00, 0x00, 0x0d];
  const ihdrType = [0x49, 0x48, 0x44, 0x52]; // "IHDR"
  const w = [
    (width >> 24) & 0xff,
    (width >> 16) & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
  ];
  const h = [
    (height >> 24) & 0xff,
    (height >> 16) & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
  ];
  const rest = [0x08, 0x06, 0x00, 0x00, 0x00]; // bit depth, color type RGBA, compression, filter, interlace
  const crc = [0x00, 0x00, 0x00, 0x00]; // dummy CRC (not validated by parser)
  return [...sig, ...ihdrLength, ...ihdrType, ...w, ...h, ...rest, ...crc];
}

/**
 * Minimal valid JPEG with SOF0 marker.
 * Structure: SOI + APP0 (short) + SOF0 with given dimensions.
 */
function minimalJpegHeader(width: number, height: number): number[] {
  const soi = [0xff, 0xd8]; // Start of image
  // APP0 marker (JFIF) - minimal
  const app0 = [
    0xff,
    0xe0, // APP0 marker
    0x00,
    0x10, // length = 16
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    0x01,
    0x01, // version 1.1
    0x00, // aspect ratio units
    0x00,
    0x01, // X density
    0x00,
    0x01, // Y density
    0x00,
    0x00, // no thumbnail
  ];
  // SOF0 marker
  const sof0 = [
    0xff,
    0xc0, // SOF0 marker
    0x00,
    0x0b, // length = 11
    0x08, // precision = 8 bits
    (height >> 8) & 0xff,
    height & 0xff, // height
    (width >> 8) & 0xff,
    width & 0xff, // width
    0x03, // number of components
    0x01,
    0x11,
    0x00, // Y component
  ];
  return [...soi, ...app0, ...sof0];
}

/**
 * Minimal valid GIF89a header with given dimensions.
 */
function minimalGifHeader(width: number, height: number): number[] {
  // "GIF89a"
  const sig = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  const w = [width & 0xff, (width >> 8) & 0xff]; // little-endian uint16
  const h = [height & 0xff, (height >> 8) & 0xff]; // little-endian uint16
  return [...sig, ...w, ...h, 0x00, 0x00]; // pad to 12 bytes
}

/**
 * Minimal valid WebP VP8 (lossy) header with given dimensions.
 */
function minimalWebpVP8Header(width: number, height: number): number[] {
  const riff = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
  const fileSize = [0x00, 0x00, 0x00, 0x00]; // dummy file size
  const webp = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
  const vp8 = [0x56, 0x50, 0x38, 0x20]; // "VP8 "
  const chunkSize = [0x00, 0x00, 0x00, 0x00]; // dummy chunk size
  // VP8 bitstream header (bytes 20-25): frame tag + start code
  const frameTag = [0x9d, 0x01, 0x2a]; // key frame tag bytes
  const padding = [0x00, 0x00, 0x00]; // padding to reach offset 26
  // Width at byte 26 (LE uint16), height at byte 28 (LE uint16)
  const w = [width & 0xff, (width >> 8) & 0x3f]; // little-endian uint16, upper bits masked
  const h = [height & 0xff, (height >> 8) & 0x3f]; // little-endian uint16, upper bits masked
  return [
    ...riff,
    ...fileSize,
    ...webp,
    ...vp8,
    ...chunkSize,
    ...frameTag,
    ...padding,
    ...w,
    ...h,
    0x00,
    0x00,
  ];
}

/**
 * Minimal valid WebP VP8L (lossless) header with given dimensions.
 */
function minimalWebpVP8LHeader(width: number, height: number): number[] {
  const riff = [0x52, 0x49, 0x46, 0x46];
  const fileSize = [0x00, 0x00, 0x00, 0x00];
  const webp = [0x57, 0x45, 0x42, 0x50];
  const vp8l = [0x56, 0x50, 0x38, 0x4c]; // "VP8L"
  const chunkSize = [0x00, 0x00, 0x00, 0x00];
  // Signature byte at offset 20
  const sigByte = [0x2f];
  // At offset 21: LE uint32 encoding width-1 in bits 0-13 and height-1 in bits 14-27
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const bitsBytes = [
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >> 24) & 0xff,
  ];
  return [
    ...riff,
    ...fileSize,
    ...webp,
    ...vp8l,
    ...chunkSize,
    ...sigByte,
    ...bitsBytes,
  ];
}

/**
 * Minimal valid WebP VP8X (extended) header with given dimensions.
 */
function minimalWebpVP8XHeader(width: number, height: number): number[] {
  const riff = [0x52, 0x49, 0x46, 0x46];
  const fileSize = [0x00, 0x00, 0x00, 0x00];
  const webp = [0x57, 0x45, 0x42, 0x50];
  const vp8x = [0x56, 0x50, 0x38, 0x58]; // "VP8X"
  const chunkSize = [0x0a, 0x00, 0x00, 0x00]; // chunk size = 10
  const flags = [0x00, 0x00, 0x00, 0x00]; // flags (bytes 20-23)
  // Width-1 as LE uint24 at offset 24
  const w1 = width - 1;
  const wBytes = [w1 & 0xff, (w1 >> 8) & 0xff, (w1 >> 16) & 0xff];
  // Height-1 as LE uint24 at offset 27
  const h1 = height - 1;
  const hBytes = [h1 & 0xff, (h1 >> 8) & 0xff, (h1 >> 16) & 0xff];
  return [
    ...riff,
    ...fileSize,
    ...webp,
    ...vp8x,
    ...chunkSize,
    ...flags,
    ...wBytes,
    ...hBytes,
  ];
}

describe("parseImageDimensions", () => {
  describe("PNG", () => {
    it("extracts dimensions from a valid PNG header", () => {
      const base64 = toBase64(minimalPngHeader(320, 240));
      const result = parseImageDimensions(base64, "image/png");
      expect(result).toEqual({ width: 320, height: 240 });
    });

    it("extracts dimensions from a large PNG", () => {
      const base64 = toBase64(minimalPngHeader(3840, 2160));
      const result = parseImageDimensions(base64, "image/png");
      expect(result).toEqual({ width: 3840, height: 2160 });
    });

    it("returns null for truncated PNG data", () => {
      const bytes = minimalPngHeader(320, 240);
      const truncated = toBase64(bytes.slice(0, 10));
      expect(parseImageDimensions(truncated, "image/png")).toBeNull();
    });

    it("returns null for corrupt PNG signature", () => {
      const bytes = minimalPngHeader(320, 240);
      bytes[0] = 0x00; // corrupt signature
      expect(parseImageDimensions(toBase64(bytes), "image/png")).toBeNull();
    });
  });

  describe("JPEG", () => {
    it("extracts dimensions from a valid JPEG with SOF0", () => {
      const base64 = toBase64(minimalJpegHeader(640, 480));
      const result = parseImageDimensions(base64, "image/jpeg");
      expect(result).toEqual({ width: 640, height: 480 });
    });

    it("extracts dimensions from a JPEG with SOF2 (progressive)", () => {
      const bytes = minimalJpegHeader(800, 600);
      // Change SOF0 (0xC0) to SOF2 (0xC2)
      const sof0Idx = bytes.indexOf(0xc0, 2);
      bytes[sof0Idx] = 0xc2;
      const result = parseImageDimensions(toBase64(bytes), "image/jpeg");
      expect(result).toEqual({ width: 800, height: 600 });
    });

    it("returns null for truncated JPEG data", () => {
      const truncated = toBase64([0xff, 0xd8, 0xff, 0xc0]);
      expect(parseImageDimensions(truncated, "image/jpeg")).toBeNull();
    });

    it("returns null for corrupt JPEG (missing SOI)", () => {
      const bytes = minimalJpegHeader(640, 480);
      bytes[0] = 0x00;
      expect(parseImageDimensions(toBase64(bytes), "image/jpeg")).toBeNull();
    });
  });

  describe("GIF", () => {
    it("extracts dimensions from a valid GIF89a header", () => {
      const base64 = toBase64(minimalGifHeader(100, 50));
      const result = parseImageDimensions(base64, "image/gif");
      expect(result).toEqual({ width: 100, height: 50 });
    });

    it("extracts dimensions from GIF87a header", () => {
      const bytes = minimalGifHeader(256, 128);
      bytes[4] = 0x37; // Change '9' to '7' for GIF87a — signature check is GIF8 only
      bytes[5] = 0x61;
      const result = parseImageDimensions(toBase64(bytes), "image/gif");
      expect(result).toEqual({ width: 256, height: 128 });
    });

    it("returns null for truncated GIF data", () => {
      const truncated = toBase64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(parseImageDimensions(truncated, "image/gif")).toBeNull();
    });

    it("returns null for corrupt GIF signature", () => {
      const bytes = minimalGifHeader(100, 50);
      bytes[0] = 0x00;
      expect(parseImageDimensions(toBase64(bytes), "image/gif")).toBeNull();
    });
  });

  describe("WebP", () => {
    it("extracts dimensions from a VP8 (lossy) WebP", () => {
      const base64 = toBase64(minimalWebpVP8Header(400, 300));
      const result = parseImageDimensions(base64, "image/webp");
      expect(result).toEqual({ width: 400, height: 300 });
    });

    it("extracts dimensions from a VP8L (lossless) WebP", () => {
      const base64 = toBase64(minimalWebpVP8LHeader(500, 250));
      const result = parseImageDimensions(base64, "image/webp");
      expect(result).toEqual({ width: 500, height: 250 });
    });

    it("extracts dimensions from a VP8X (extended) WebP", () => {
      const base64 = toBase64(minimalWebpVP8XHeader(1920, 1080));
      const result = parseImageDimensions(base64, "image/webp");
      expect(result).toEqual({ width: 1920, height: 1080 });
    });

    it("returns null for truncated WebP data", () => {
      const truncated = toBase64([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      ]);
      expect(parseImageDimensions(truncated, "image/webp")).toBeNull();
    });

    it("returns null for corrupt RIFF signature", () => {
      const bytes = minimalWebpVP8Header(400, 300);
      bytes[0] = 0x00;
      expect(parseImageDimensions(toBase64(bytes), "image/webp")).toBeNull();
    });
  });

  describe("unknown media type", () => {
    it("returns null for unsupported media type", () => {
      expect(parseImageDimensions("AAAA", "image/bmp")).toBeNull();
    });

    it("returns null for non-image media type", () => {
      expect(parseImageDimensions("AAAA", "application/pdf")).toBeNull();
    });
  });

  describe("empty/invalid data", () => {
    it("returns null for empty base64 string", () => {
      expect(parseImageDimensions("", "image/png")).toBeNull();
      expect(parseImageDimensions("", "image/jpeg")).toBeNull();
      expect(parseImageDimensions("", "image/gif")).toBeNull();
      expect(parseImageDimensions("", "image/webp")).toBeNull();
    });
  });

  describe("real image file", () => {
    it("parses dimensions from an actual PNG file in the repo", () => {
      const pngPath = join(
        import.meta.dir,
        "../../..",
        "clients/chrome-extension/icons/icon16.png",
      );
      const pngData = readFileSync(pngPath);
      const base64 = pngData.toString("base64");
      const result = parseImageDimensions(base64, "image/png");
      expect(result).toEqual({ width: 16, height: 16 });
    });
  });
});
