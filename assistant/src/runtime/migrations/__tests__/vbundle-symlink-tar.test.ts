/**
 * In-memory tar emit / parse / validate coverage for the typeflag-2 symlink
 * entry shape introduced in the vbundle-symlinks plan (PR 2).
 *
 * These tests exercise the round-trip through `buildVBundle` →
 * `validateVBundle` plus three negative paths: traversal rejection, a
 * tampered `link_target` field, and a tampered `sha256` digest.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { canonicalizeJson, validateVBundle } from "../vbundle-validator.js";
import { defaultV1Options } from "./v1-test-helpers.js";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Decode the manifest from a built archive, run the supplied mutator, recompute
 * the manifest checksum, and rebuild the archive. Mirrors the
 * `dropFromManifestAndRepack` pattern from `vbundle-streaming-importer.test.ts`.
 *
 * Assumes the manifest is the first tar entry and has no PAX prefix.
 */
function mutateManifestAndRepack(
  archive: Uint8Array,
  mutate: (
    contents: Array<{
      path: string;
      sha256: string;
      size_bytes: number;
      link_target?: string;
    }>,
  ) => void,
): Uint8Array {
  const raw = gunzipSync(archive);
  const sizeStr = new TextDecoder()
    .decode(raw.subarray(124, 136))
    .replace(/\0.*$/, "")
    .trim();
  const origSize = parseInt(sizeStr, 8);
  const manifestJson = new TextDecoder().decode(
    raw.subarray(512, 512 + origSize),
  );
  const manifest = JSON.parse(manifestJson) as {
    contents: Array<{
      path: string;
      sha256: string;
      size_bytes: number;
      link_target?: string;
    }>;
    checksum: string;
    [k: string]: unknown;
  };

  mutate(manifest.contents);

  // Recompute the v1 checksum: empty-string placeholder, then canonicalize.
  const withEmptyChecksum: Record<string, unknown> = {
    ...manifest,
    checksum: "",
  };
  manifest.checksum = sha256Hex(canonicalizeJson(withEmptyChecksum));

  const newJson = JSON.stringify(manifest);
  const newBytes = new TextEncoder().encode(newJson);

  const header = new Uint8Array(512);
  header.set(raw.subarray(0, 512), 0);
  const newSizeOctal = newBytes.length.toString(8).padStart(11, "0");
  for (let i = 0; i < 11; i++) {
    header[124 + i] = newSizeOctal.charCodeAt(i);
  }
  header[135] = 0;
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const cksum = sum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) header[148 + i] = cksum.charCodeAt(i);
  header[154] = 0;
  header[155] = 0x20;

  const oldPaddedLen = 512 + Math.ceil(origSize / 512) * 512;
  const newPadded = Math.ceil(newBytes.length / 512) * 512;
  const out = new Uint8Array(
    header.length + newPadded + (raw.length - oldPaddedLen),
  );
  out.set(header, 0);
  out.set(newBytes, 512);
  out.set(raw.subarray(oldPaddedLen), 512 + newPadded);
  return gzipSync(out);
}

describe("vbundle symlink tar — emit / parse / validate", () => {
  test("round-trip: regular files and a typeflag-2 symlink validate cleanly", () => {
    const files = [
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
    ];

    const { archive, manifest } = buildVBundle({
      files,
      ...defaultV1Options(),
    });
    const result = validateVBundle(archive);

    expect(result.is_valid).toBe(true);
    expect(result.errors).toEqual([]);

    const symlinkEntry = result.entries!.get("workspace/skills/foo.md");
    expect(symlinkEntry).toBeDefined();
    expect(symlinkEntry!.linkname).toBe("bar.md");
    expect(symlinkEntry!.size).toBe(0);

    const symlinkContent = manifest.contents.find(
      (c) => c.path === "workspace/skills/foo.md",
    )!;
    expect(symlinkContent.link_target).toBe("bar.md");
    expect(symlinkContent.size_bytes).toBe(0);
    expect(symlinkContent.sha256).toBe(sha256Hex("bar.md"));

    // Regular file entries should NOT carry a linkname.
    const regularEntry = result.entries!.get("workspace/skills/bar.md");
    expect(regularEntry!.linkname).toBeUndefined();
  });

  test("symlink target that escapes the archive root is rejected", () => {
    const files = [
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "../../../etc/passwd",
      },
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
    ];

    const { archive } = buildVBundle({ files, ...defaultV1Options() });
    const result = validateVBundle(archive);

    expect(result.is_valid).toBe(false);
    const traversal = result.errors.find(
      (e) => e.code === "SYMLINK_TARGET_ESCAPES_ARCHIVE",
    );
    expect(traversal).toBeDefined();
    expect(traversal!.path).toBe("workspace/skills/foo.md");
  });

  test("manifest link_target tampered to a different value surfaces LINK_TARGET_MISMATCH", () => {
    const files = [
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
    ];

    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    // Mutate the manifest entry so it points at a different target than the
    // one carried in the tar header. Recompute sha256 over the new target so
    // the checksum check passes and we exercise the linkname-mismatch branch.
    const tampered = mutateManifestAndRepack(archive, (contents) => {
      const entry = contents.find((c) => c.path === "workspace/skills/foo.md")!;
      const newTarget = "different.md";
      entry.link_target = newTarget;
      entry.sha256 = sha256Hex(newTarget);
    });

    const result = validateVBundle(tampered);
    expect(result.is_valid).toBe(false);
    const mismatch = result.errors.find(
      (e) => e.code === "LINK_TARGET_MISMATCH",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.path).toBe("workspace/skills/foo.md");
  });

  test("manifest sha256 tampered for a symlink entry surfaces FILE_CHECKSUM_MISMATCH", () => {
    const files = [
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
    ];

    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    const wrongDigest = "0".repeat(64);
    const tampered = mutateManifestAndRepack(archive, (contents) => {
      const entry = contents.find((c) => c.path === "workspace/skills/foo.md")!;
      entry.sha256 = wrongDigest;
    });

    const result = validateVBundle(tampered);
    expect(result.is_valid).toBe(false);
    const checksum = result.errors.find(
      (e) => e.code === "FILE_CHECKSUM_MISMATCH",
    );
    expect(checksum).toBeDefined();
    expect(checksum!.path).toBe("workspace/skills/foo.md");
  });
});
