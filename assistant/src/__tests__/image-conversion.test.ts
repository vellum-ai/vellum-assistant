/**
 * Tests for the shared sips-backed image converter.
 *
 * Pure logic (ftyp sniffing, filename rewriting, passthrough behavior) runs
 * everywhere; actual conversion requires macOS `sips`, so those cases are
 * gated on darwin.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import {
  convertImageToJpeg,
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

describe("normalizeImageBytes passthrough", () => {
  test("non-HEIF bytes pass through untouched", () => {
    const result = normalizeImageBytes("image/png", PNG_1PX_BYTES);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toBe(PNG_1PX_BYTES);
  });

  test("HEIF header with undecodable payload passes through", () => {
    // sips fails (or is absent off-macOS) → the original bytes are kept.
    const fake = fakeHeifHeaderBytes();
    const result = normalizeImageBytes("image/heic", fake);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/heic");
    expect(result.bytes).toBe(fake);
  });
});

describe("normalizeImageBase64 passthrough", () => {
  test("non-HEIF payloads skip conversion", () => {
    const b64 = PNG_1PX_BYTES.toString("base64");
    const result = normalizeImageBase64("image/png", b64);
    expect(result.converted).toBe(false);
    expect(result.dataBase64).toBe(b64);
  });
});

describe("declared-MIME correction from sniffed bytes", () => {
  test("normalizeImageBytes relabels a mislabeled image, bytes untouched", () => {
    // A JPEG renamed to .png arrives declared as image/png; providers reject
    // the mismatch, so the sniffed format wins.
    const result = normalizeImageBytes("image/png", JPEG_HEADER_BYTES);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes).toBe(JPEG_HEADER_BYTES);
  });

  test("normalizeImageBase64 relabels a mislabeled image, payload untouched", () => {
    const b64 = PNG_1PX_BYTES.toString("base64");
    const result = normalizeImageBase64("image/jpeg", b64);
    expect(result.converted).toBe(false);
    expect(result.mimeType).toBe("image/png");
    expect(result.dataBase64).toBe(b64);
  });

  test("unrecognized bytes keep the declared MIME", () => {
    const bytes = Buffer.from("plain text content");
    const result = normalizeImageBytes("text/plain", bytes);
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

    test("convertImageToJpeg produces JPEG bytes", () => {
      const converted = convertImageToJpeg(heicBytes);
      expect(converted).not.toBeNull();
      expect(startsWithJpegMagic(converted!)).toBe(true);
    });

    test("conversion options produce distinct outputs (cache key isolation)", () => {
      // A hash-only cache key would make the second call return the first
      // call's cached full-resolution output.
      const fullRes = convertImageToJpeg(heicBytes, { quality: 90 });
      const downscaled = convertImageToJpeg(heicBytes, {
        maxDimensionPx: 16,
        quality: 90,
      });
      expect(fullRes).not.toBeNull();
      expect(downscaled).not.toBeNull();
      expect(fullRes!.equals(downscaled!)).toBe(false);
    });

    test("repeated conversion is stable (cache round-trip)", () => {
      const first = convertImageToJpeg(heicBytes, { quality: 90 });
      const second = convertImageToJpeg(heicBytes, { quality: 90 });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.equals(second!)).toBe(true);
    });

    test("normalizeImageBytes converts to a JPEG master", () => {
      const result = normalizeImageBytes("image/heic", heicBytes);
      expect(result.converted).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
      expect(startsWithJpegMagic(result.bytes)).toBe(true);
    });

    test("normalizeImageBytes converts even when the declared mime is wrong", () => {
      // Chromium reports empty file.type for .heic; clients coerce it to
      // application/octet-stream. Detection is content-based.
      const result = normalizeImageBytes("application/octet-stream", heicBytes);
      expect(result.converted).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
    });

    test("normalizeImageBase64 converts and re-encodes", () => {
      const result = normalizeImageBase64(
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
