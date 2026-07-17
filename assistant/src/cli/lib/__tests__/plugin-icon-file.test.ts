/**
 * Tests for {@link readValidatedPluginIcon} — the fail-closed `icon.png`
 * validator. An icon is surfaced only when the file is a PNG (correct magic
 * bytes) whose IHDR dimensions are within 128×128 and whose size is within
 * 32 KB. Every other shape — missing, wrong magic, oversized dims/bytes,
 * unreadable — is "no icon" (`{ hasIcon: false }`) and never throws.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MAX_ICON_BYTES,
  MAX_ICON_DIMENSION,
  readValidatedPluginIcon,
  validatePluginIconBytes,
} from "../plugin-icon-file.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Build a minimal PNG buffer with a valid signature and IHDR width/height.
 * `padBytes` appends filler after the header so callers can produce an
 * oversized-but-otherwise-valid file for the size-cap case.
 */
function makePng(width: number, height: number, padBytes = 0): Buffer {
  const buf = Buffer.alloc(24 + Math.max(0, padBytes));
  PNG_SIGNATURE.copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii"); // IHDR chunk type
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function sha16(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "plugin-icon-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

function writeIcon(bytes: Buffer): void {
  writeFileSync(join(pluginDir, "icon.png"), bytes);
}

describe("readValidatedPluginIcon", () => {
  test("accepts a valid <=128x128 <=32KB PNG with a content-hash version", () => {
    // GIVEN a small, well-formed PNG at the fixed path
    const bytes = makePng(64, 64);
    writeIcon(bytes);

    // WHEN we validate it
    const result = readValidatedPluginIcon(pluginDir);

    // THEN it is surfaced with a stable content-hash version and its path
    expect(result.hasIcon).toBe(true);
    expect(result.iconVersion).toBe(sha16(bytes));
    expect(result.path).toBe(join(pluginDir, "icon.png"));
  });

  test("accepts exactly 128x128 (the dimension boundary)", () => {
    writeIcon(makePng(128, 128));
    expect(readValidatedPluginIcon(pluginDir).hasIcon).toBe(true);
  });

  test("returns a stable iconVersion across repeated reads of the same bytes", () => {
    writeIcon(makePng(32, 48));
    const first = readValidatedPluginIcon(pluginDir);
    const second = readValidatedPluginIcon(pluginDir);
    expect(first.iconVersion).toBe(second.iconVersion);
  });

  test("iconVersion changes when the bytes change", () => {
    writeIcon(makePng(32, 32));
    const before = readValidatedPluginIcon(pluginDir).iconVersion;
    writeIcon(makePng(48, 48));
    const after = readValidatedPluginIcon(pluginDir).iconVersion;
    expect(before).not.toBe(after);
  });

  test("rejects a non-PNG file with wrong magic bytes (renamed JPEG/text)", () => {
    // GIVEN a file with JPEG magic bytes renamed to icon.png
    const jpeg = Buffer.alloc(24);
    jpeg.writeUInt16BE(0xffd8, 0); // JPEG SOI marker
    writeIcon(jpeg);

    // THEN it is rejected without throwing
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects plain text renamed to icon.png", () => {
    writeIcon(Buffer.from("<svg>not a png at all, just some text</svg>"));
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects oversized dimensions (129x129)", () => {
    writeIcon(makePng(129, 129));
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects zero-dimension IHDR", () => {
    writeIcon(makePng(0, 0));
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects a PNG larger than 32KB", () => {
    // GIVEN a valid-header PNG padded past the 32 KB cap
    writeIcon(makePng(64, 64, 33 * 1024));
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects a truncated file too short to hold an IHDR", () => {
    writeIcon(PNG_SIGNATURE); // 8 bytes — signature only, no IHDR
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("rejects a signature-prefixed file whose first chunk is not IHDR", () => {
    // Valid signature + in-range integers at offsets 16/20, but the first
    // chunk type is IDAT — must not be treated as dimensions.
    const buf = makePng(64, 64);
    buf.write("IDAT", 12, "ascii");
    writeIcon(buf);
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("returns hasIcon:false when no icon.png exists", () => {
    expect(readValidatedPluginIcon(pluginDir)).toEqual({ hasIcon: false });
  });

  test("returns hasIcon:false for a non-existent plugin directory", () => {
    const missing = join(pluginDir, "does-not-exist");
    expect(readValidatedPluginIcon(missing)).toEqual({ hasIcon: false });
  });
});

describe("validatePluginIconBytes", () => {
  test("accepts a valid <=128x128 PNG with a content-hash version (no path)", () => {
    // GIVEN well-formed in-memory PNG bytes
    const bytes = makePng(64, 64);

    // WHEN we validate them directly
    const result = validatePluginIconBytes(bytes);

    // THEN it is surfaced with a stable content-hash version and no path
    expect(result).toEqual({ hasIcon: true, iconVersion: sha16(bytes) });
  });

  test("accepts exactly MAX_ICON_DIMENSION (the boundary)", () => {
    const bytes = makePng(MAX_ICON_DIMENSION, MAX_ICON_DIMENSION);
    expect(validatePluginIconBytes(bytes).hasIcon).toBe(true);
  });

  test("rejects oversized dimensions (129x129)", () => {
    const bytes = makePng(MAX_ICON_DIMENSION + 1, MAX_ICON_DIMENSION + 1);
    expect(validatePluginIconBytes(bytes)).toEqual({ hasIcon: false });
  });

  test("rejects a buffer larger than MAX_ICON_BYTES", () => {
    const bytes = makePng(64, 64, MAX_ICON_BYTES + 1);
    expect(validatePluginIconBytes(bytes)).toEqual({ hasIcon: false });
  });

  test("rejects a buffer with wrong magic bytes", () => {
    const jpeg = Buffer.alloc(24);
    jpeg.writeUInt16BE(0xffd8, 0); // JPEG SOI marker
    expect(validatePluginIconBytes(jpeg)).toEqual({ hasIcon: false });
  });

  test("rejects a signature-prefixed buffer whose first chunk is not IHDR", () => {
    const buf = makePng(64, 64);
    buf.write("IDAT", 12, "ascii");
    expect(validatePluginIconBytes(buf)).toEqual({ hasIcon: false });
  });

  test("rejects a buffer shorter than the minimum header", () => {
    expect(validatePluginIconBytes(PNG_SIGNATURE)).toEqual({ hasIcon: false });
  });
});
