/**
 * Tests for the shared sips-backed image converter.
 *
 * Pure logic (ftyp sniffing, filename rewriting, passthrough behavior) runs
 * everywhere; actual conversion requires macOS `sips`, so those cases are
 * gated on darwin.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import {
  convertImageToJpeg,
  hasValidJpegStructure,
  isCompleteJpeg,
  isHeifImage,
  jpegFilenameFor,
  normalizeImageBase64,
  normalizeImageBytes,
  sniffBase64ImageMimeType,
  sniffImageFileMimeType,
  sniffImageMimeType,
} from "../util/image-conversion.js";
import {
  fakeHeifHeaderBytes,
  makeHeicFixtureBytes,
  PNG_1PX_BYTES,
} from "./heic-fixture.js";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function startsWithJpegMagic(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.slice(0, 3)).equals(JPEG_MAGIC);
}

describe("isHeifImage", () => {
  test("accepts HEIF ftyp brands", () => {
    for (const brand of ["heic", "heix", "heif", "mif1", "msf1", "hevc"]) {
      expect(isHeifImage(fakeHeifHeaderBytes(brand))).toBe(true);
    }
  });

  test("rejects AVIF brands (Chromium decodes AVIF natively)", () => {
    expect(isHeifImage(fakeHeifHeaderBytes("avif"))).toBe(false);
    expect(isHeifImage(fakeHeifHeaderBytes("avis"))).toBe(false);
  });

  test("rejects non-ISO-BMFF content", () => {
    expect(isHeifImage(PNG_1PX_BYTES)).toBe(false);
    expect(isHeifImage(Buffer.from("plain text content"))).toBe(false);
  });

  test("rejects buffers shorter than the sniff window", () => {
    expect(isHeifImage(Buffer.alloc(0))).toBe(false);
    expect(isHeifImage(Buffer.from("ftypheic"))).toBe(false);
  });
});

describe("jpegFilenameFor", () => {
  test("rewrites the extension to .jpg", () => {
    expect(jpegFilenameFor("IMG_5487.HEIC")).toBe("IMG_5487.jpg");
    expect(jpegFilenameFor("photo.heif")).toBe("photo.jpg");
    expect(jpegFilenameFor("archive.tar.gz")).toBe("archive.tar.jpg");
  });

  test("keeps existing .jpg/.jpeg extensions", () => {
    expect(jpegFilenameFor("photo.jpg")).toBe("photo.jpg");
    expect(jpegFilenameFor("photo.JPEG")).toBe("photo.JPEG");
  });

  test("handles missing or empty names", () => {
    expect(jpegFilenameFor("photo")).toBe("photo.jpg");
    expect(jpegFilenameFor("")).toBe("attachment.jpg");
    expect(jpegFilenameFor(".heic")).toBe("attachment.jpg");
  });
});

const JPEG_HEADER_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_HEADER_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP_HEADER_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
]);

describe("sniffImageMimeType", () => {
  test("identifies PNG, JPEG, GIF, and WebP signatures", () => {
    expect(sniffImageMimeType(PNG_1PX_BYTES)).toBe("image/png");
    expect(sniffImageMimeType(JPEG_HEADER_BYTES)).toBe("image/jpeg");
    expect(sniffImageMimeType(GIF_HEADER_BYTES)).toBe("image/gif");
    expect(sniffImageMimeType(WEBP_HEADER_BYTES)).toBe("image/webp");
  });

  test("returns null for unrecognized or truncated content", () => {
    expect(sniffImageMimeType(Buffer.from("plain text content"))).toBeNull();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMimeType(fakeHeifHeaderBytes())).toBeNull();
    // RIFF container that is not WebP (e.g. WAV audio).
    expect(
      sniffImageMimeType(
        Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.from([0x24, 0x00, 0x00, 0x00]),
          Buffer.from("WAVEfmt "),
        ]),
      ),
    ).toBeNull();
  });

  test("base64 variant sniffs from the encoded head", () => {
    expect(sniffBase64ImageMimeType(PNG_1PX_BYTES.toString("base64"))).toBe(
      "image/png",
    );
    expect(
      sniffBase64ImageMimeType(Buffer.from("not an image").toString("base64")),
    ).toBeNull();
  });

  test("file variant sniffs from the on-disk head", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-sniff-file-"));
    // A PNG named .jpg — what arrives when the MIME is extension-derived.
    const pngPath = join(dir, "photo.jpg");
    writeFileSync(pngPath, PNG_1PX_BYTES);
    expect(sniffImageFileMimeType(pngPath)).toBe("image/png");

    const textPath = join(dir, "notes.txt");
    writeFileSync(textPath, "plain text content");
    expect(sniffImageFileMimeType(textPath)).toBeNull();

    expect(sniffImageFileMimeType(join(dir, "missing.png"))).toBeNull();
  });
});

describe("isCompleteJpeg", () => {
  test("accepts SOI...EOI framed payloads", () => {
    expect(
      isCompleteJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])),
    ).toBe(true);
  });

  test("rejects empty, truncated, and non-JPEG payloads", () => {
    expect(isCompleteJpeg(Buffer.alloc(0))).toBe(false);
    // Valid head, torn tail: the poisoned-cache signature.
    expect(isCompleteJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe(
      false,
    );
    expect(isCompleteJpeg(PNG_1PX_BYTES)).toBe(false);
  });
});

// Mirrors the converter's cache-key derivation so the test can plant a
// poisoned entry at the exact path a conversion will consult.
function cacheKeyFor(bytes: Uint8Array, quality: number): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${hash}-full-q${quality}`;
}

// Minimal structurally valid JPEG: SOI, APP0 (len 4, 2 payload bytes),
// SOF0 (len 5, 3 payload bytes), SOS (len 3, 1 payload byte), entropy data
// with a stuffed FF, then EOI.
function minimalJpeg(extra: {
  trailing?: Uint8Array;
  dropEoi?: boolean;
}): Buffer {
  const parts: Uint8Array[] = [
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), // APP0
    Buffer.from([0xff, 0xc0, 0x00, 0x05, 0x08, 0x00, 0x01]), // SOF0
    Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]), // SOS header
    Buffer.from([0x12, 0xff, 0x00, 0x34]), // entropy data with stuffed FF
  ];
  if (!extra.dropEoi) {
    parts.push(Buffer.from([0xff, 0xd9])); // EOI
  }
  if (extra.trailing) {
    parts.push(extra.trailing);
  }
  return Buffer.concat(parts);
}

describe("hasValidJpegStructure", () => {
  test("accepts a JPEG with trailing bytes after the EOI marker", () => {
    // Some encoders append padding or metadata past the EOI; the structural
    // walk tolerates it where isCompleteJpeg's exact tail framing does not.
    const padded = minimalJpeg({ trailing: Buffer.from([0x00, 0x00]) });
    expect(hasValidJpegStructure(padded)).toBe(true);
    expect(isCompleteJpeg(padded)).toBe(false);
  });

  test("accepts restart markers inside entropy-coded data", () => {
    const withRst = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x05, 0x08, 0x00, 0x01]), // SOF0
      Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]),
      Buffer.from([0x12, 0xff, 0xd0, 0x34]), // RST0 continues the scan
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(hasValidJpegStructure(withRst)).toBe(true);
  });

  test("rejects a truncated JPEG whose metadata segment contains FF D9", () => {
    // An EXIF-style APP1 payload can embed a complete thumbnail JPEG, so an
    // FF D9 pair appears inside the segment while the main image is torn. A
    // raw byte search would accept this; the marker walk skips the segment
    // payload and reports the truncation.
    const tornWithThumbnail = Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from([0xff, 0xe1, 0x00, 0x08]), // APP1, length 8
      Buffer.from([0x45, 0x78, 0xff, 0xd9, 0x00, 0x00]), // payload with FF D9
      Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x12, 0x34]), // torn scan
    ]);
    expect(hasValidJpegStructure(tornWithThumbnail)).toBe(false);
  });

  test("rejects truncated JPEGs and non-JPEG payloads", () => {
    expect(hasValidJpegStructure(minimalJpeg({ dropEoi: true }))).toBe(false);
    expect(
      hasValidJpegStructure(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])),
    ).toBe(false);
    expect(hasValidJpegStructure(Buffer.alloc(0))).toBe(false);
    expect(hasValidJpegStructure(PNG_1PX_BYTES)).toBe(false);
  });

  test("rejects a top-level EOI with no frame or scan", () => {
    // Bare SOI+EOI is structurally walkable but carries no image data;
    // providers reject it, so the gate must too.
    expect(hasValidJpegStructure(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(
      false,
    );
    // A scan without a frame header is equally undecodable.
    const scanNoFrame = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x12]),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(hasValidJpegStructure(scanNoFrame)).toBe(false);
  });

  test("rejects a segment length that runs past the buffer", () => {
    // A declared length larger than the remaining bytes is truncation, not a
    // reason to scan beyond the buffer.
    const overrun = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
    expect(hasValidJpegStructure(overrun)).toBe(false);
  });
});

describe("normalizeImageBytes passthrough", () => {
  test("non-HEIF bytes pass through untouched", async () => {
    const result = await normalizeImageBytes("image/png", PNG_1PX_BYTES);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toBe(PNG_1PX_BYTES);
  });

  test("HEIF header with undecodable payload passes through", async () => {
    // sips fails (or is absent off-macOS) → the original bytes are kept.
    const fake = fakeHeifHeaderBytes();
    const result = await normalizeImageBytes("image/heic", fake);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/heic");
    expect(result.bytes).toBe(fake);
  });
});

describe("normalizeImageBase64 passthrough", () => {
  test("non-HEIF payloads skip conversion", async () => {
    const b64 = PNG_1PX_BYTES.toString("base64");
    const result = await normalizeImageBase64("image/png", b64);
    expect(result.converted).toBe(false);
    expect(result.dataBase64).toBe(b64);
  });
});

describe("declared-MIME correction from sniffed bytes", () => {
  test("normalizeImageBytes relabels a mislabeled image, bytes untouched", async () => {
    // A JPEG renamed to .png arrives declared as image/png; providers reject
    // the mismatch, so the sniffed format wins.
    const result = await normalizeImageBytes("image/png", JPEG_HEADER_BYTES);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes).toBe(JPEG_HEADER_BYTES);
  });

  test("normalizeImageBase64 relabels a mislabeled image, payload untouched", async () => {
    const b64 = PNG_1PX_BYTES.toString("base64");
    const result = await normalizeImageBase64("image/jpeg", b64);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/png");
    expect(result.dataBase64).toBe(b64);
  });

  test("unrecognized bytes keep the declared MIME", async () => {
    const bytes = Buffer.from("plain text content");
    const result = await normalizeImageBytes("text/plain", bytes);
    expect(result.mimeType).toBe("text/plain");
    expect(result.bytes).toBe(bytes);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "real HEIC conversion (sips)",
  () => {
    let heicBytes: Buffer;

    beforeAll(() => {
      const fixture = makeHeicFixtureBytes();
      if (!fixture) {
        throw new Error("sips failed to produce a HEIC fixture on darwin");
      }
      heicBytes = fixture;
    });

    test("fixture sniffs as HEIF", () => {
      expect(isHeifImage(heicBytes)).toBe(true);
    });

    test("convertImageToJpeg produces JPEG bytes", async () => {
      const converted = await convertImageToJpeg(heicBytes);
      expect(converted).not.toBeNull();
      expect(startsWithJpegMagic(converted!)).toBe(true);
      // A real encoder's output must pass the structural walk, or the
      // compactor gate would drop every legitimately converted image.
      expect(hasValidJpegStructure(converted!)).toBe(true);
    });

    test("conversion options produce distinct outputs (cache key isolation)", async () => {
      // A hash-only cache key would make the second call return the first
      // call's cached full-resolution output.
      const fullRes = await convertImageToJpeg(heicBytes, { quality: 90 });
      const downscaled = await convertImageToJpeg(heicBytes, {
        maxDimensionPx: 16,
        quality: 90,
      });
      expect(fullRes).not.toBeNull();
      expect(downscaled).not.toBeNull();
      expect(fullRes!.equals(downscaled!)).toBe(false);
    });

    test("repeated conversion is stable (cache round-trip)", async () => {
      const first = await convertImageToJpeg(heicBytes, { quality: 90 });
      const second = await convertImageToJpeg(heicBytes, { quality: 90 });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.equals(second!)).toBe(true);
    });

    test("a poisoned (truncated) cache entry is discarded, not returned", async () => {
      // Distinct quality so this test owns its cache key.
      const quality = 77;
      const cacheDir = join(tmpdir(), "vellum-optimized-images");
      mkdirSync(cacheDir, { recursive: true });
      const poisonedPath = join(
        cacheDir,
        `${cacheKeyFor(heicBytes, quality)}.jpg`,
      );
      // A torn write: valid JPEG head, no EOI tail. readFromCache must
      // discard it rather than return it as the converted image.
      writeFileSync(poisonedPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

      const converted = await convertImageToJpeg(heicBytes, { quality });
      expect(converted).not.toBeNull();
      expect(isCompleteJpeg(converted!)).toBe(true);

      // The poisoned entry was replaced by the re-converted result.
      expect(existsSync(poisonedPath)).toBe(true);
      const { readFileSync } = await import("node:fs");
      expect(isCompleteJpeg(readFileSync(poisonedPath))).toBe(true);
    });

    test("normalizeImageBytes converts to a JPEG master", async () => {
      const result = await normalizeImageBytes("image/heic", heicBytes);
      expect(result.converted).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
      expect(startsWithJpegMagic(result.bytes)).toBe(true);
    });

    test("normalizeImageBytes converts even when the declared mime is wrong", async () => {
      // Chromium reports empty file.type for .heic; clients coerce it to
      // application/octet-stream. Detection is content-based.
      const result = await normalizeImageBytes(
        "application/octet-stream",
        heicBytes,
      );
      expect(result.converted).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
    });

    test("normalizeImageBase64 converts and re-encodes", async () => {
      const result = await normalizeImageBase64(
        "image/heic",
        heicBytes.toString("base64"),
      );
      expect(result.converted).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
      expect(
        startsWithJpegMagic(Buffer.from(result.dataBase64, "base64")),
      ).toBe(true);
    });
  },
);
