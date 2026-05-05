/**
 * Verifies that the buffered (`buildVBundle` / `buildExportVBundle`) and
 * streaming (`streamExportVBundle`) emit paths both produce manifests
 * conforming to the canonical v1 ten-field shape.
 *
 * Drift between the two emit paths is exactly how the prior schema
 * mismatch went unnoticed — these tests pin both paths to the same shape
 * and run a round-trip through `validateVBundle` so any future
 * canonicalization drift fails loudly.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import {
  buildExportVBundle,
  buildVBundle,
  streamExportVBundle,
} from "../vbundle-builder.js";
import { canonicalizeJson, validateVBundle } from "../vbundle-validator.js";
import { defaultV1Options } from "./v1-test-helpers.js";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function createTestWorkspace(): { dir: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `vbundle-v1-shape-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ test: true }));
  const dbDir = join(dir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, "assistant.db"), "fake-db-content");
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

describe("buildVBundle — v1 ten-field manifest shape", () => {
  test("emits all ten required top-level fields with correct types", () => {
    const { manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
    });

    expect(manifest.schema_version).toBe(1);
    expect(typeof manifest.bundle_id).toBe("string");
    expect(manifest.bundle_id).toMatch(UUID_V4_RE);
    expect(manifest.created_at).toMatch(ISO_8601_RE);
    expect(manifest.assistant.id).toBe("self");
    expect(manifest.assistant.name).toBe("Test");
    expect(manifest.assistant.runtime_version).toBe("0.0.0-test");
    expect(manifest.origin.mode).toBe("self-hosted-local");
    expect(manifest.compatibility.min_runtime_version).toBe("0.0.0-test");
    expect(manifest.compatibility.max_runtime_version).toBeNull();
    expect(Array.isArray(manifest.contents)).toBe(true);
    expect(manifest.contents.length).toBeGreaterThan(0);
    expect(manifest.checksum).toMatch(SHA256_HEX_RE);
    expect(typeof manifest.secrets_redacted).toBe("boolean");
    expect(typeof manifest.export_options.include_logs).toBe("boolean");
  });

  test("contents always declares data/db/assistant.db when the input includes it", () => {
    const { manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
        {
          path: "config/settings.json",
          data: new TextEncoder().encode("{}"),
        },
      ],
      ...defaultV1Options(),
    });

    const dbEntry = manifest.contents.find(
      (f) => f.path === "data/db/assistant.db",
    );
    expect(dbEntry).toBeDefined();
    expect(dbEntry!.size_bytes).toBe(
      new TextEncoder().encode("db-bytes").length,
    );
  });

  test("checksum is the sha256 of the canonicalized manifest with checksum=''", () => {
    const { manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
    });

    const expected = sha256Hex(canonicalizeJson({ ...manifest, checksum: "" }));
    expect(manifest.checksum).toBe(expected);
  });

  test("secrets_redacted reflects the input flag", () => {
    const truthy = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
      secretsRedacted: true,
    });
    expect(truthy.manifest.secrets_redacted).toBe(true);

    const falsey = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
      secretsRedacted: false,
    });
    expect(falsey.manifest.secrets_redacted).toBe(false);
  });

  test("bundle_id is a fresh UUID per export", () => {
    const a = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
    });
    const b = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
        },
      ],
      ...defaultV1Options(),
    });
    expect(a.manifest.bundle_id).not.toBe(b.manifest.bundle_id);
  });
});

describe("streamExportVBundle — v1 ten-field manifest shape", () => {
  test("matches buildExportVBundle's manifest shape (modulo bundle_id and created_at)", async () => {
    const workspace = createTestWorkspace();
    let streamResult:
      | Awaited<ReturnType<typeof streamExportVBundle>>
      | undefined;
    try {
      const sync = buildExportVBundle({
        workspaceDir: workspace.dir,
        ...defaultV1Options(),
      });
      streamResult = await streamExportVBundle({
        workspaceDir: workspace.dir,
        ...defaultV1Options(),
      });

      expect(streamResult.manifest.schema_version).toBe(
        sync.manifest.schema_version,
      );
      expect(streamResult.manifest.assistant).toEqual(sync.manifest.assistant);
      expect(streamResult.manifest.origin).toEqual(sync.manifest.origin);
      expect(streamResult.manifest.compatibility).toEqual(
        sync.manifest.compatibility,
      );
      expect(streamResult.manifest.export_options).toEqual(
        sync.manifest.export_options,
      );
      expect(streamResult.manifest.secrets_redacted).toBe(
        sync.manifest.secrets_redacted,
      );

      // Same set of files (paths + sha + size).
      const sortByPath = (a: { path: string }, b: { path: string }) =>
        a.path.localeCompare(b.path);
      expect(streamResult.manifest.contents.slice().sort(sortByPath)).toEqual(
        sync.manifest.contents.slice().sort(sortByPath),
      );
    } finally {
      await streamResult?.cleanup();
      workspace.cleanup();
    }
  });
});

describe("buildExportVBundle round-trip", () => {
  test("validateVBundle accepts the buffered emit", () => {
    const workspace = createTestWorkspace();
    try {
      const result = buildExportVBundle({
        workspaceDir: workspace.dir,
        ...defaultV1Options(),
      });
      const validation = validateVBundle(result.archive);
      expect(validation.is_valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.manifest?.checksum).toBe(result.manifest.checksum);
    } finally {
      workspace.cleanup();
    }
  });

  test("validateVBundle accepts the streaming emit", async () => {
    const workspace = createTestWorkspace();
    let result: Awaited<ReturnType<typeof streamExportVBundle>> | undefined;
    try {
      result = await streamExportVBundle({
        workspaceDir: workspace.dir,
        ...defaultV1Options(),
      });
      const archive = new Uint8Array(
        await Bun.file(result.tempPath).arrayBuffer(),
      );
      // Sanity: archive is valid gzip of a tar.
      expect(gunzipSync(archive).length).toBeGreaterThan(0);
      const validation = validateVBundle(archive);
      expect(validation.is_valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.manifest?.checksum).toBe(result.manifest.checksum);
    } finally {
      await result?.cleanup();
      workspace.cleanup();
    }
  });
});
