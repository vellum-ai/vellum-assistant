/**
 * HEIC fixture helpers for image-conversion tests.
 *
 * Real HEIC bytes can only be produced where `sips` exists (macOS), so
 * consumers gate those tests with `describe.skipIf(process.platform !==
 * "darwin")`. The fake-header helper works everywhere and exercises the
 * conversion-failure fallback: the ftyp sniff accepts it, sips rejects it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Create real HEIC bytes via macOS `sips` (1×1 PNG upscaled to 64×64, then
 * HEIC-encoded). Returns null when sips is unavailable or fails.
 */
export function makeHeicFixtureBytes(): Buffer | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "vellum-heic-fixture-"));
    const pngPath = join(dir, "src.png");
    const bigPngPath = join(dir, "big.png");
    const heicPath = join(dir, "out.heic");
    writeFileSync(pngPath, Buffer.from(PNG_1PX_BASE64, "base64"));
    execFileSync("sips", ["-z", "64", "64", pngPath, "--out", bigPngPath], {
      stdio: "pipe",
    });
    execFileSync(
      "sips",
      ["-s", "format", "heic", bigPngPath, "--out", heicPath],
      { stdio: "pipe" },
    );
    return readFileSync(heicPath) as Buffer;
  } catch {
    return null;
  }
}

/**
 * A syntactically valid HEIF ftyp header followed by nothing decodable.
 * Sniffs as HEIF but fails conversion on every platform.
 */
export function fakeHeifHeaderBytes(brand = "heic"): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write(brand, 8, "ascii");
  return buf;
}

export const PNG_1PX_BYTES = Buffer.from(PNG_1PX_BASE64, "base64");
