/**
 * In-memory tar emit / parse / validate coverage for the typeflag-2 symlink
 * entry shape introduced in the vbundle-symlinks plan (PR 2).
 *
 * These tests exercise the round-trip through `buildVBundle` →
 * `validateVBundle` plus three negative paths: traversal rejection, a
 * tampered `link_target` field, and a tampered `sha256` digest.
 */

import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  canonicalizeJson,
  computeManifestChecksum,
  validateVBundle,
} from "../vbundle-validator.js";
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

  test("absolute symlink target is rejected as escaping the archive root", () => {
    // An absolute target like "/etc/passwd" is unconstrained by the bundle
    // root: the prior `posix.normalize(posix.join(dirname, target))` guard
    // returns "/etc/passwd" unchanged, which does not start with "../" and
    // would otherwise pass. The validator must catch absolute targets up
    // front and surface them with the same SYMLINK_TARGET_ESCAPES_ARCHIVE
    // code as `..`-based escapes.
    const files = [
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "/etc/passwd",
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

  test("typeflag-2 entry whose tar header declares a non-zero size surfaces FILE_SIZE_MISMATCH", () => {
    // Hand-craft a bundle so we can violate an invariant the buildVBundle
    // emit path enforces: a symlink header that lies about its size.
    //
    // The validator's downstream check `archiveEntry.size !== 0` only fires
    // if `parseTar` propagates the tar-declared size for typeflag-2 entries
    // — not if it forces 0. This regression test pins that contract.
    //
    // Layout:
    //   - manifest.json header + body
    //   - foo.md symlink header (typeflag '2', linkname=bar.md, size=0o123)
    //   - end-of-archive (two zero blocks)

    const BLOCK = 512;
    const enc = new TextEncoder();

    function buildHeader(opts: {
      name: string;
      size: number;
      typeflag: string;
      linkname?: string;
    }): Uint8Array {
      const h = new Uint8Array(BLOCK);
      const nameBytes = enc.encode(opts.name);
      h.set(nameBytes.subarray(0, 100), 0);
      const writeOctal = (off: number, len: number, value: number) => {
        const s = value.toString(8).padStart(len - 1, "0");
        for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
        h[off + len - 1] = 0;
      };
      writeOctal(100, 8, 0o644);
      writeOctal(108, 8, 0);
      writeOctal(116, 8, 0);
      writeOctal(124, 12, opts.size);
      writeOctal(136, 12, Math.floor(Date.now() / 1000));
      h[156] = opts.typeflag.charCodeAt(0);
      if (opts.linkname) {
        const lk = enc.encode(opts.linkname);
        h.set(lk.subarray(0, 100), 157);
      }
      const magic = enc.encode("ustar\0");
      h.set(magic, 257);
      h[263] = "0".charCodeAt(0);
      h[264] = "0".charCodeAt(0);
      // Checksum field starts as eight spaces per spec
      for (let i = 148; i < 156; i++) h[i] = 0x20;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += h[i];
      const cksum = sum.toString(8).padStart(6, "0");
      for (let i = 0; i < 6; i++) h[148 + i] = cksum.charCodeAt(i);
      h[154] = 0;
      h[155] = 0x20;
      return h;
    }

    function padBlock(data: Uint8Array): Uint8Array {
      const rem = data.length % BLOCK;
      if (rem === 0) return data;
      const padded = new Uint8Array(data.length + (BLOCK - rem));
      padded.set(data);
      return padded;
    }

    // Build manifest declaring foo.md as a symlink with size_bytes 0,
    // sha256 over the link target string. That matches what buildVBundle
    // would emit; the discrepancy lives in the tar header alone.
    const linkTarget = "bar.md";
    const symlinkSha = sha256Hex(linkTarget);
    const manifest = {
      schema_version: 1,
      bundle_id: randomUUID(),
      created_at: new Date().toISOString(),
      assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
      origin: { mode: "self-hosted-local" },
      compatibility: {
        min_runtime_version: "0.0.0-test",
        max_runtime_version: null,
      },
      contents: [
        {
          path: "workspace/skills/foo.md",
          sha256: symlinkSha,
          size_bytes: 0,
          link_target: linkTarget,
        },
        {
          path: "workspace/data/db/assistant.db",
          sha256: sha256Hex(enc.encode("db-bytes")),
          size_bytes: 8,
        },
      ],
      checksum: "",
      secrets_redacted: false,
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
    };
    manifest.checksum = computeManifestChecksum(manifest);

    const manifestBytes = enc.encode(JSON.stringify(manifest));
    const manifestHeader = buildHeader({
      name: "manifest.json",
      size: manifestBytes.length,
      typeflag: "0",
    });
    const manifestPart = new Uint8Array(BLOCK + padBlock(manifestBytes).length);
    manifestPart.set(manifestHeader, 0);
    manifestPart.set(padBlock(manifestBytes), BLOCK);

    // Symlink header: declares size=0o123 (= 83 decimal). parseTar must
    // propagate this 83 so the FILE_SIZE_MISMATCH check fires; if it forces
    // 0, the bug is silent. We pad one block of zero body bytes after the
    // header (the `Math.ceil(83/512) = 1` blocks parseTar will skip) so the
    // following DB entry header lands at the correct block boundary.
    const symlinkHeader = buildHeader({
      name: "workspace/skills/foo.md",
      size: 0o123,
      typeflag: "2",
      linkname: linkTarget,
    });
    const symlinkBodyPadding = new Uint8Array(BLOCK);
    const symlinkPart = new Uint8Array(
      symlinkHeader.length + symlinkBodyPadding.length,
    );
    symlinkPart.set(symlinkHeader, 0);
    symlinkPart.set(symlinkBodyPadding, symlinkHeader.length);

    // Regular file body for the DB entry so the manifest's required-DB
    // refine is satisfied.
    const dbBytes = enc.encode("db-bytes");
    const dbHeader = buildHeader({
      name: "workspace/data/db/assistant.db",
      size: dbBytes.length,
      typeflag: "0",
    });
    const dbPart = new Uint8Array(BLOCK + padBlock(dbBytes).length);
    dbPart.set(dbHeader, 0);
    dbPart.set(padBlock(dbBytes), BLOCK);

    const eoa = new Uint8Array(BLOCK * 2);

    const total =
      manifestPart.length + symlinkPart.length + dbPart.length + eoa.length;
    const tar = new Uint8Array(total);
    let off = 0;
    tar.set(manifestPart, off);
    off += manifestPart.length;
    tar.set(symlinkPart, off);
    off += symlinkPart.length;
    tar.set(dbPart, off);
    off += dbPart.length;
    tar.set(eoa, off);

    const archive = gzipSync(tar);
    const result = validateVBundle(archive);

    expect(result.is_valid).toBe(false);
    const sizeMismatch = result.errors.find(
      (e) =>
        e.code === "FILE_SIZE_MISMATCH" && e.path === "workspace/skills/foo.md",
    );
    expect(sizeMismatch).toBeDefined();
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
