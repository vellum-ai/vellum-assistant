/**
 * Tests for the v1-tightened `validateVBundle` schema.
 *
 * Covers:
 *   - Accepts a v1 ten-field manifest produced by `buildVBundle`.
 *   - Rejects every legacy six-field manifest shape.
 *   - Rejects when `schema_version` is anything other than `1`.
 *   - Enforces the managed-mode redaction `.refine()` (`origin.mode === "managed" ⇒ secrets_redacted === true`).
 *   - Enforces the `data/db/assistant.db`-in-contents `.refine()`.
 *   - Rejects when the declared `checksum` doesn't match the recomputed self-checksum.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  canonicalizeJson,
  computeLegacyManifestSha256,
  computeManifestChecksum,
  ManifestSchema,
  validateVBundle,
} from "../vbundle-validator.js";
import { buildTestManifest, defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Tar helpers — minimum-viable to wrap a manifest object into a vbundle.
// ---------------------------------------------------------------------------

const BLOCK = 512;

function padToBlock(data: Uint8Array): Uint8Array {
  const r = data.length % BLOCK;
  if (r === 0) return data;
  const out = new Uint8Array(data.length + (BLOCK - r));
  out.set(data);
  return out;
}

function writeOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const s = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
  buf[offset + length - 1] = 0;
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const header = new Uint8Array(BLOCK);
  header.set(enc.encode(name).subarray(0, 100), 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header[156] = "0".charCodeAt(0);
  header.set(enc.encode("ustar\0"), 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  writeOctal(header, 148, 7, sum);
  header[155] = 0x20;
  const padded = padToBlock(data);
  const out = new Uint8Array(header.length + padded.length);
  out.set(header, 0);
  out.set(padded, header.length);
  return out;
}

function tarArchive(
  entries: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = entries.map((e) => tarEntry(e.name, e.data));
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function gzipTarOf(
  manifestObj: Record<string, unknown>,
  files: Array<{ name: string; data: Uint8Array }> = [],
): Uint8Array {
  const manifestData = new TextEncoder().encode(JSON.stringify(manifestObj));
  return gzipSync(
    tarArchive([{ name: "manifest.json", data: manifestData }, ...files]),
  );
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const DB_BYTES = new TextEncoder().encode("db-bytes");

function v1Skeleton(): Record<string, unknown> {
  return {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: "2026-04-01T00:00:00Z",
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    contents: [
      {
        path: "data/db/assistant.db",
        sha256: sha256Hex(DB_BYTES),
        size_bytes: DB_BYTES.length,
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
}

function withChecksum(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const checksum = computeManifestChecksum(manifest);
  return { ...manifest, checksum };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManifestSchema — v1 acceptance", () => {
  test("accepts a freshly-built v1 manifest from buildVBundle", () => {
    const { archive } = buildVBundle({
      files: [{ path: "data/db/assistant.db", data: DB_BYTES }],
      ...defaultV1Options(),
    });
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe(1);
  });

  test("accepts when origin.mode === 'managed' and secrets_redacted === true", () => {
    const manifest = withChecksum({
      ...v1Skeleton(),
      origin: { mode: "managed" },
      secrets_redacted: true,
    });
    const archive = gzipTarOf(manifest, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
  });
});

describe("ManifestSchema — v1 rejection", () => {
  test("rejects schema_version !== 1", () => {
    const manifest = withChecksum({ ...v1Skeleton(), schema_version: 2 });
    const archive = gzipTarOf(manifest, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
  });

  test("rejects managed mode with secrets_redacted=false", () => {
    const manifest = withChecksum({
      ...v1Skeleton(),
      origin: { mode: "managed" },
      secrets_redacted: false,
    });
    const archive = gzipTarOf(manifest, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
  });

  test("rejects manifest whose contents lacks data/db/assistant.db", () => {
    const manifest = withChecksum({
      ...v1Skeleton(),
      contents: [
        {
          path: "config/settings.json",
          sha256: sha256Hex(new TextEncoder().encode("{}")),
          size_bytes: 2,
        },
      ],
    });
    const archive = gzipTarOf(manifest);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
  });

  test("rejects a checksum that does not match the recomputed self-checksum", () => {
    // Build a structurally valid manifest but tamper with `checksum` after
    // computing it so the validator's recomputation fails.
    const valid = withChecksum(v1Skeleton());
    const tampered = {
      ...valid,
      // Twiddle one byte; still 64 hex chars so the schema accepts it,
      // but the recomputation rejects it.
      checksum:
        (valid.checksum as string).slice(0, -1) +
        ((valid.checksum as string).slice(-1) === "0" ? "1" : "0"),
    };
    const archive = gzipTarOf(tampered, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "MANIFEST_CHECKSUM_MISMATCH"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy six-field manifest fallback — required for backwards compatibility
// with on-disk bundles produced by pre-v1 runtimes (backup snapshots,
// cross-version migration artifacts). AGENTS.md prohibits silent breaks of
// persisted state.
// ---------------------------------------------------------------------------

function legacySkeleton(
  files: Array<{ path: string; sha256: string; size: number }>,
): Record<string, unknown> {
  return {
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    source: "runtime-export",
    description: "legacy fixture",
    files,
    manifest_sha256: "",
  };
}

function withLegacyChecksum(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  // `computeLegacyManifestSha256` strips the field internally before
  // canonicalizing, so passing the manifest in unmodified is correct.
  const manifest_sha256 = computeLegacyManifestSha256(manifest);
  return { ...manifest, manifest_sha256 };
}

describe("ManifestSchema — legacy fallback (backwards compatibility)", () => {
  test("accepts a valid legacy six-field manifest", () => {
    const legacy = withLegacyChecksum(
      legacySkeleton([
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size: DB_BYTES.length,
        },
      ]),
    );
    const archive = gzipTarOf(legacy, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
  });

  test("rejects a legacy manifest with a wrong manifest_sha256", () => {
    const legacy = {
      ...legacySkeleton([
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size: DB_BYTES.length,
        },
      ]),
      // Deliberately wrong checksum.
      manifest_sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const archive = gzipTarOf(legacy, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "MANIFEST_CHECKSUM_MISMATCH"),
    ).toBe(true);
  });

  test("translator surfaces a v1 ManifestType to downstream consumers", () => {
    const legacy = withLegacyChecksum(
      legacySkeleton([
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size: DB_BYTES.length,
        },
      ]),
    );
    const archive = gzipTarOf(legacy, [
      { name: "data/db/assistant.db", data: DB_BYTES },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
    expect(result.manifest).toBeDefined();
    // Translation fills in v1 fields and renames legacy fields.
    expect(result.manifest?.schema_version).toBe(1);
    expect(result.manifest?.contents).toHaveLength(1);
    expect(result.manifest?.contents[0]?.path).toBe("data/db/assistant.db");
    expect(result.manifest?.contents[0]?.size_bytes).toBe(DB_BYTES.length);
    expect(result.manifest?.contents[0]?.sha256).toBe(sha256Hex(DB_BYTES));
    // Conservative defaults so the v1 refines never trip.
    expect(result.manifest?.origin.mode).toBe("self-hosted-local");
    expect(result.manifest?.secrets_redacted).toBe(false);
  });

  test("legacy manifest with corrupted file payload still flags FILE_CHECKSUM_MISMATCH", () => {
    // Verifies the per-file integrity pipeline runs on translated legacy
    // bundles too — translation must preserve `files` → `contents` /
    // `size` → `size_bytes` so verification works uniformly.
    const legacy = withLegacyChecksum(
      legacySkeleton([
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size: DB_BYTES.length,
        },
      ]),
    );
    const corruptedDb = new TextEncoder().encode("not-the-real-db-bytes");
    const archive = gzipTarOf(legacy, [
      { name: "data/db/assistant.db", data: corruptedDb },
    ]);
    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "FILE_CHECKSUM_MISMATCH")).toBe(
      true,
    );
  });
});

describe("ManifestFileEntry — link_target field", () => {
  test("accepts manifest entry with link_target", () => {
    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size_bytes: 1,
          link_target: "bar.md",
        },
      ],
    });
    const result = ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contents[0]?.link_target).toBe("bar.md");
    }
  });

  test("accepts manifest entry without link_target (backwards-compat)", () => {
    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size_bytes: 1,
        },
      ],
    });
    const result = ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  test("rejects manifest entry with empty link_target", () => {
    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: sha256Hex(DB_BYTES),
          size_bytes: 1,
          link_target: "",
        },
      ],
    });
    const result = ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});

// Exercise canonicalizeJson + computeManifestChecksum themselves to keep the
// helpers from rotting if signatures change.
describe("computeManifestChecksum helper", () => {
  test("ignores the existing checksum value when computing the canonical form", () => {
    const a = withChecksum(v1Skeleton());
    const b = withChecksum({ ...v1Skeleton(), checksum: "deadbeef" });
    // Both inputs canonicalize to the same form (checksum field replaced by
    // empty string), so both produce the same checksum.
    expect(a.checksum).toBe(b.checksum);
    // Sanity: the same canonicalization explanation as in the validator.
    const expected = sha256Hex(
      canonicalizeJson({ ...v1Skeleton(), checksum: "" }),
    );
    expect(a.checksum).toBe(expected);
  });
});
