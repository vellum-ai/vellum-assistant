/**
 * Tests for `streamCommitImport` — the streaming `.vbundle` importer.
 *
 * Covered:
 * - Happy path: multi-file bundle lands in workspace; report shape matches
 *   buffer-based `commitImport`.
 * - Manifest-first-failure: non-manifest first entry → validation_failed,
 *   temp dir cleaned, real workspace untouched.
 * - Mid-stream hash failure: tampered manifest sha → validation_failed,
 *   temp dir cleaned, real workspace untouched.
 * - Missing entry: manifest declares a file that's absent from the tar →
 *   validation_failed with offending path surfaced.
 * - Extra entry (manifest_mismatch): tar carries a file the manifest does
 *   not declare → validation_failed.
 * - Memory ceiling: 100 MB fixture streams through without pushing heap
 *   past ~64 MB, proving we're not buffering the whole bundle.
 * - Sanity parity: buffer-based `commitImport` and `streamCommitImport`
 *   produce report objects with the same field shape for the same input.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { streamCommitImport } from "../vbundle-streaming-importer.js";
import { canonicalizeJson } from "../vbundle-validator.js";
import { defaultV1Options } from "./v1-test-helpers.js";

/**
 * Fixed "customized" guardian persona content used by the USER.md-skip
 * test. Has user-authored content past the bare scaffold, so
 * `isGuardianPersonaCustomized` returns true.
 */
const CUSTOMIZED_PERSONA_FIXTURE = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

- Preferred name/reference: Real User
- Pronouns: she/her
- Locale: en-US
- Work role: Staff Engineer
- Goals: Ship drop-user-md
- Hobbies/fun: Reading papers
- Daily tools: Terminal, Vellum
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp workspace dir whose parent we own, so the atomic-swap rename
 * (`workspaceDir` → `workspaceDir.pre-import-<ts>`) stays inside the test
 * sandbox instead of polluting $TMPDIR with stale siblings.
 */
function freshWorkspace(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "vbundle-stream-import-")),
  );
  const workspaceDir = join(parent, "workspace");
  // Don't mkdir — leaving it absent lets us verify "real workspace untouched"
  // semantics clearly. Individual tests that need an existing workspace
  // create it themselves.
  return workspaceDir;
}

function readableFrom(buf: Uint8Array): Readable {
  return Readable.from([Buffer.from(buf)]);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Strip a specific ustar entry from an already-built archive. Keeps the
 * manifest (first entry) intact and drops the entry whose name matches
 * `entryName`. Assumes no PAX/longname entries precede the target.
 */
function removeEntry(archive: Uint8Array, entryName: string): Uint8Array {
  const raw = gunzipSync(archive);

  let offset = 0;
  while (offset + 512 <= raw.length) {
    const block = raw.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;

    // Entry name is at offset 0..100 of the header, null-terminated.
    let nameEnd = 0;
    while (nameEnd < 100 && block[nameEnd] !== 0) nameEnd += 1;
    const name = new TextDecoder().decode(block.subarray(0, nameEnd));

    const sizeStr = new TextDecoder()
      .decode(block.subarray(124, 136))
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeStr, 8) || 0;
    const dataBlocks = Math.ceil(size / 512);
    const entryLen = 512 + dataBlocks * 512;

    if (name === entryName) {
      const out = new Uint8Array(raw.length - entryLen);
      out.set(raw.subarray(0, offset), 0);
      out.set(raw.subarray(offset + entryLen), offset);
      return gzipSync(out);
    }

    offset += entryLen;
  }

  throw new Error(
    `removeEntry: test helper could not find entry "${entryName}" in archive`,
  );
}

/**
 * Update manifest.json in place to drop the entry with the given archive
 * path AND recompute the v1 `checksum` so the manifest itself stays valid.
 * Used to craft the "extra entry" (manifest_mismatch) fixture — the tar
 * has the file, but the manifest does not.
 */
function dropFromManifestAndRepack(
  archive: Uint8Array,
  pathToDrop: string,
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
    contents: Array<{ path: string; sha256: string; size_bytes: number }>;
    checksum: string;
    [k: string]: unknown;
  };
  manifest.contents = manifest.contents.filter((f) => f.path !== pathToDrop);
  // Recompute checksum: place an empty-string placeholder in the canonical
  // form, exactly mirroring the v1 emit-time canonicalization.
  const withEmptyChecksum: Record<string, unknown> = {
    ...manifest,
    checksum: "",
  };
  manifest.checksum = sha256Hex(canonicalizeJson(withEmptyChecksum));

  const newJson = JSON.stringify(manifest);
  const newBytes = new TextEncoder().encode(newJson);

  // The manifest has almost certainly changed length — rebuild the tar.
  // Rewrite the first entry's size field and pad the body to the next
  // 512-byte boundary, then concatenate everything after the old manifest.
  const header = new Uint8Array(512);
  header.set(raw.subarray(0, 512), 0);
  const newSizeOctal = newBytes.length.toString(8).padStart(11, "0");
  for (let i = 0; i < 11; i++) {
    header[124 + i] = newSizeOctal.charCodeAt(i);
  }
  header[135] = 0;
  // Zero out the old checksum field before recomputing.
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("streamCommitImport — happy path", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    // Clean up any sibling temp/backup dirs left under the workspace parent.
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("writes every file into the workspace and returns a report with the expected shape", async () => {
    const fileA = new TextEncoder().encode("alpha alpha alpha\n");
    const fileB = new TextEncoder().encode("beta beta\n");
    const fileC = new TextEncoder().encode("gamma payload\n");

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        { path: "workspace/a.txt", data: fileA },
        { path: "workspace/sub/b.txt", data: fileB },
        { path: "workspace/sub/c.txt", data: fileC },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(existsSync(join(workspaceDir, "a.txt"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "a.txt"))).toEqual(
      Buffer.from(fileA),
    );
    expect(readFileSync(join(workspaceDir, "sub/b.txt"))).toEqual(
      Buffer.from(fileB),
    );
    expect(readFileSync(join(workspaceDir, "sub/c.txt"))).toEqual(
      Buffer.from(fileC),
    );

    expect(result.report.success).toBe(true);
    // Includes the synthetic data/db/assistant.db entry plus a/b/c.txt.
    expect(result.report.summary.total_files).toBe(4);
    expect(result.report.summary.files_created).toBe(4);
    expect(result.report.manifest.contents).toHaveLength(4);
    for (const f of result.report.files) {
      expect(f.action).toBe("created");
      expect(f.backup_path).toBeNull();
      expect(typeof f.sha256).toBe("string");
      expect(f.disk_path.startsWith(workspaceDir)).toBe(true);
    }
  });

  test("invokes onProgress after each file entry finishes", async () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/a.txt",
          data: new TextEncoder().encode("one"),
        },
        {
          path: "workspace/b.txt",
          data: new TextEncoder().encode("two!"),
        },
      ],
      ...defaultV1Options(),
    });

    const events: Array<{
      archivePath: string;
      bytesWritten: number;
      entryIndex: number;
    }> = [];
    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
      onProgress: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(events.map((e) => e.archivePath)).toEqual([
      "data/db/assistant.db",
      "workspace/a.txt",
      "workspace/b.txt",
    ]);
    expect(events[1]?.bytesWritten).toBe(3);
    expect(events[2]?.bytesWritten).toBe(4);
    expect(events[0]?.entryIndex).toBeLessThan(events[1]?.entryIndex ?? -1);
  });

  test("forwards credentials to importCredentials callback but never writes them to disk", async () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/config.json",
          data: new TextEncoder().encode("{}"),
        },
        {
          path: "credentials/openai-key",
          data: new TextEncoder().encode("sk-test-1"),
        },
        {
          path: "credentials/anthropic-key",
          data: new TextEncoder().encode("sk-ant-2"),
        },
      ],
      ...defaultV1Options(),
    });

    const received: Array<{ account: string; value: string }> = [];
    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
      importCredentials: async (creds) => {
        received.push(...creds);
      },
    });

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(2);
    expect(received).toContainEqual({
      account: "openai-key",
      value: "sk-test-1",
    });
    expect(received).toContainEqual({
      account: "anthropic-key",
      value: "sk-ant-2",
    });
    // Credentials must NOT appear on disk.
    expect(existsSync(join(workspaceDir, "credentials"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure modes — every one must leave the real workspace untouched and
// clean up the sibling temp dir.
// ---------------------------------------------------------------------------

describe("streamCommitImport — failure modes", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Ensure no sibling temp/backup dirs for this workspace remain. */
  function assertNoLeftoverTempDirs(): void {
    const parent = join(workspaceDir, "..");
    const base = workspaceDir.split("/").pop()!;
    const siblings = readdirSync(parent);
    const leftover = siblings.filter(
      (name) =>
        name.startsWith(`${base}.import-`) ||
        name.startsWith(`${base}.pre-import-`),
    );
    expect(leftover).toEqual([]);
  }

  test("manifest-first failure: non-manifest first entry → validation_failed, real workspace untouched", async () => {
    // Seed the real workspace with a marker file so we can verify it's
    // untouched after the failed import.
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    // Hand-roll a gzipped tar whose first entry is NOT manifest.json.
    // Reuse buildVBundle for a valid archive, then strip the manifest
    // entry using removeEntry — the remaining archive opens with a
    // workspace/ file as entry #1.
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/a.txt",
          data: new TextEncoder().encode("hello"),
        },
      ],
      ...defaultV1Options(),
    });
    const noManifest = removeEntry(archive, "manifest.json");

    const result = await streamCommitImport({
      source: readableFrom(noManifest),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");

    // Real workspace's pre-existing content is still there, unmodified.
    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });

  test("mid-stream hash failure: tampered manifest sha → validation_failed, cleanup intact", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    // Build a valid bundle with one file whose data is 32 bytes long.
    const body = new TextEncoder().encode("x".repeat(32));
    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        { path: "workspace/victim.txt", data: body },
      ],
      ...defaultV1Options(),
    });

    // Tamper the per-file sha256 for workspace/victim.txt by substituting
    // one hex character. Keeps the manifest schema-valid (substitution is
    // same-length) — but because the v1 `checksum` is recomputed over the
    // declared data, we ALSO need to recompute `checksum` (with the empty
    // placeholder) to keep the manifest itself valid. Otherwise the
    // manifest fails its self-checksum and the test exercises the wrong
    // path.
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
      contents: Array<{ path: string; sha256: string; size_bytes: number }>;
      checksum: string;
      [k: string]: unknown;
    };
    manifest.contents = manifest.contents.map((f) =>
      f.path === "workspace/victim.txt"
        ? {
            ...f,
            // Deterministic-but-wrong sha: flip the high bit of char 0.
            sha256: "0" + f.sha256.slice(1),
          }
        : f,
    );
    const withEmptyChecksum: Record<string, unknown> = {
      ...manifest,
      checksum: "",
    };
    manifest.checksum = sha256Hex(canonicalizeJson(withEmptyChecksum));

    const newJson = JSON.stringify(manifest);
    const newBytes = new TextEncoder().encode(newJson);
    if (newBytes.length !== origSize) {
      throw new Error(
        `hash-failure test fixture: manifest length drifted (${newBytes.length} vs ${origSize})`,
      );
    }
    const tampered = new Uint8Array(raw.length);
    tampered.set(raw);
    tampered.set(newBytes, 512);
    const tamperedArchive = gzipSync(tampered);

    const result = await streamCommitImport({
      source: readableFrom(tamperedArchive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");

    // Existing workspace content preserved, no temp dir hanging around.
    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });

  test("missing entry: manifest declares a path absent from the tar → validation_failed", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/present.txt",
          data: new TextEncoder().encode("here"),
        },
        {
          path: "workspace/missing.txt",
          data: new TextEncoder().encode("gone"),
        },
      ],
      ...defaultV1Options(),
    });
    const stripped = removeEntry(archive, "workspace/missing.txt");

    const result = await streamCommitImport({
      source: readableFrom(stripped),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");
    // The error payload should surface the missing path.
    const combined = JSON.stringify(result);
    expect(combined).toContain("workspace/missing.txt");

    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });

  test("extra entry: tar contains a file the manifest does not declare → validation_failed", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/declared.txt",
          data: new TextEncoder().encode("fine"),
        },
        {
          path: "workspace/extra.txt",
          data: new TextEncoder().encode("surprise"),
        },
      ],
      ...defaultV1Options(),
    });
    const extraPresent = dropFromManifestAndRepack(
      archive,
      "workspace/extra.txt",
    );

    const result = await streamCommitImport({
      source: readableFrom(extraPresent),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");

    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });
});

// ---------------------------------------------------------------------------
// Memory ceiling — the point of the streaming path.
// ---------------------------------------------------------------------------

/**
 * Materialize a ~100 MB .vbundle fixture on disk and return its path.
 * Wrapping the build in its own function lets the intermediate Uint8Arrays
 * go out of scope before we start measuring heap — the fixture itself
 * must not count against the importer's working-set budget.
 */
function writeLargeFixtureToDisk(archivePath: string): void {
  const CHUNK = 25 * 1024 * 1024;
  const files = [
    { path: "data/db/assistant.db", data: new Uint8Array() },
    ...[0, 1, 2, 3].map((i) => ({
      path: `workspace/big-${i}.bin`,
      data: new Uint8Array(CHUNK).fill(0x41 + i),
    })),
  ];
  const { archive } = buildVBundle({ files, ...defaultV1Options() });
  writeFileSync(archivePath, archive);
}

describe("streamCommitImport — memory ceiling", () => {
  test("100 MB fixture streams in without pushing RSS past ~64 MB over baseline", async () => {
    const workspaceDir = freshWorkspace();
    const parent = join(workspaceDir, "..");
    const archivePath = join(parent, "fixture.vbundle");

    try {
      // Build the fixture in an isolated scope so intermediate buffers go
      // out of scope before we start measuring.
      writeLargeFixtureToDisk(archivePath);

      // Bun's `process.memoryUsage().heapUsed` can include accounting for
      // off-heap Buffer backing stores, so a strict heap ceiling is noisy
      // across engines. Use RSS instead — that's the actual "did the
      // process grow" signal. If the importer were buffering the full 100
      // MB archive, RSS would spike by at least 100 MB; a streaming
      // importer's per-entry working set is bounded by ~one tar entry's
      // internal buffers (a few MB).
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      let progressCount = 0;

      const result = await streamCommitImport({
        source: createReadStream(archivePath),
        pathResolver: new DefaultPathResolver(workspaceDir),
        workspaceDir,
        onProgress: () => {
          progressCount += 1;
          const cur = process.memoryUsage().rss;
          if (cur > peakRss) peakRss = cur;
        },
      });

      expect(result.ok).toBe(true);
      // We expect onProgress to fire at least 4 times (one per big file) —
      // spot-check that we actually sampled during import.
      expect(progressCount).toBeGreaterThanOrEqual(4);

      // The 64 MB delta bound is a rough guard proving "it doesn't buffer
      // the whole bundle" — if the importer were accumulating the 100 MB
      // archive in memory, RSS would jump well past this threshold.
      const delta = peakRss - baselineRss;
      expect(delta).toBeLessThan(64 * 1024 * 1024);
    } finally {
      try {
        rmSync(parent, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Sanity parity with buffer-based commitImport.
// ---------------------------------------------------------------------------

describe("streamCommitImport — report parity with commitImport", () => {
  test("buffer-based and streaming importer produce report objects with the same field shape", async () => {
    const bufferWorkspace = freshWorkspace();
    const streamWorkspace = freshWorkspace();

    const files = [
      {
        path: "data/db/assistant.db",
        data: new Uint8Array(),
      },
      {
        path: "workspace/a.txt",
        data: new TextEncoder().encode("alpha"),
      },
      {
        path: "workspace/sub/b.txt",
        data: new TextEncoder().encode("beta beta"),
      },
    ];
    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    // Buffer-based path.
    mkdirSync(bufferWorkspace, { recursive: true });
    const bufferResult = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(bufferWorkspace),
      workspaceDir: bufferWorkspace,
    });

    // Streaming path.
    const streamResult = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(streamWorkspace),
      workspaceDir: streamWorkspace,
    });

    try {
      expect(bufferResult.ok).toBe(true);
      expect(streamResult.ok).toBe(true);
      if (!bufferResult.ok || !streamResult.ok) throw new Error("unreachable");

      // The shapes must match key-for-key.
      expect(Object.keys(streamResult.report).sort()).toEqual(
        Object.keys(bufferResult.report).sort(),
      );
      expect(Object.keys(streamResult.report.summary).sort()).toEqual(
        Object.keys(bufferResult.report.summary).sort(),
      );
      expect(streamResult.report.files.length).toBe(
        bufferResult.report.files.length,
      );
      for (let i = 0; i < streamResult.report.files.length; i++) {
        expect(Object.keys(streamResult.report.files[i]).sort()).toEqual(
          Object.keys(bufferResult.report.files[i]).sort(),
        );
      }

      // Manifest payload itself should match — the streaming path parses it
      // directly from the same bytes.
      expect(streamResult.report.manifest.checksum).toBe(
        bufferResult.report.manifest.checksum,
      );
    } finally {
      for (const ws of [bufferWorkspace, streamWorkspace]) {
        const parent = join(ws, "..");
        try {
          rmSync(parent, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Parity with commitImport: workspace-swap gating, config sanitization,
// legacy USER.md skip when persona is customized. Each of these regressed
// when the streaming path was first introduced.
// ---------------------------------------------------------------------------

describe("streamCommitImport — no workspace entries means no swap", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("bundle with only credentials leaves the real workspace untouched", async () => {
    // Seed the real workspace with a marker file. A successful import that
    // had workspace entries would wipe-and-swap this file out of existence,
    // so its survival post-import proves we skipped the rename pair.
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "marker-please-preserve.txt"),
      "do not touch\n",
    );
    mkdirSync(join(workspaceDir, "deep", "nested"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "deep", "nested", "file.txt"),
      "nested content\n",
    );

    // Credential entries resolve to null via DefaultPathResolver — they are
    // buffered in memory for CES, never land on disk. A bundle consisting
    // entirely of credentials therefore has zero workspace-targeted writes.
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "credentials/openai-key",
          data: new TextEncoder().encode("sk-test-creds-only"),
        },
      ],
      ...defaultV1Options(),
    });

    const received: Array<{ account: string; value: string }> = [];
    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
      importCredentials: async (creds) => {
        received.push(...creds);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Real workspace's pre-existing files are STILL THERE — the temp tree
    // was not swapped in.
    expect(
      readFileSync(join(workspaceDir, "marker-please-preserve.txt"), "utf8"),
    ).toBe("do not touch\n");
    expect(
      readFileSync(join(workspaceDir, "deep", "nested", "file.txt"), "utf8"),
    ).toBe("nested content\n");

    // Credentials still flowed through post-commit as they should.
    expect(received).toEqual([
      { account: "openai-key", value: "sk-test-creds-only" },
    ]);

    // Report should reflect "only the synthetic data/db/assistant.db
    // landed; no `workspace/*` entries were written".
    expect(result.report.summary.files_created).toBe(1);
    expect(result.report.summary.files_overwritten).toBe(0);
    expect(
      result.report.files.find((f) => f.path === "data/db/assistant.db")
        ?.action,
    ).toBe("created");

    // Cleanup removed the temp dir — no sibling left behind.
    const parent = join(workspaceDir, "..");
    const base = workspaceDir.split("/").pop()!;
    const siblings = readdirSync(parent);
    const leftover = siblings.filter(
      (name) =>
        name.startsWith(`${base}.import-`) ||
        name.startsWith(`${base}.pre-import-`),
    );
    expect(leftover).toEqual([]);
  });

  test("bundle with only out-of-workspace resolved targets leaves real workspace untouched", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "marker-please-preserve.txt"),
      "survive\n",
    );

    // A resolver that resolves paths OUTSIDE the workspace dir — the
    // streaming importer drains these through the verifier and records
    // them as skipped, so no writes land in the temp workspace.
    const outOfWorkspaceDir = realpathSync(
      mkdtempSync(join(tmpdir(), "oow-target-")),
    );
    const externalResolver = {
      resolve(archivePath: string): string | null {
        if (archivePath.startsWith("credentials/")) return null;
        return join(outOfWorkspaceDir, archivePath.replace(/\//g, "_"));
      },
    };

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/something.txt",
          data: new TextEncoder().encode("ignored"),
        },
      ],
      ...defaultV1Options(),
    });

    try {
      const result = await streamCommitImport({
        source: readableFrom(archive),
        pathResolver: externalResolver,
        workspaceDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      // Everything was skipped as "outside workspace".
      expect(result.report.summary.files_skipped).toBeGreaterThanOrEqual(1);
      expect(result.report.summary.files_created).toBe(0);

      // Real workspace is still intact.
      expect(
        readFileSync(join(workspaceDir, "marker-please-preserve.txt"), "utf8"),
      ).toBe("survive\n");
    } finally {
      try {
        rmSync(outOfWorkspaceDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});

describe("streamCommitImport — config sanitization parity", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("workspace/config.json is sanitized before being written", async () => {
    // sanitizeConfigForTransfer strips `daemon` entirely, clears
    // `ingress.publicBaseUrl`, deletes `ingress.enabled`, and zeros
    // `skills.load.extraDirs`. We plant all of these in the archived
    // config and assert they're gone on disk.
    const tainted = JSON.stringify({
      daemon: { pid: 1234, host: "private.example.com" },
      ingress: { publicBaseUrl: "https://leaky.example", enabled: true },
      skills: { load: { extraDirs: ["/tmp/leak-a", "/tmp/leak-b"] } },
      unrelated: "keep-me",
    });

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/config.json",
          data: new TextEncoder().encode(tainted),
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const writtenPath = join(workspaceDir, "config.json");
    expect(existsSync(writtenPath)).toBe(true);
    const writtenJson = JSON.parse(readFileSync(writtenPath, "utf8")) as Record<
      string,
      unknown
    >;

    // Environment-specific fields have been stripped or reset.
    expect(writtenJson.daemon).toBeUndefined();
    expect((writtenJson.ingress as Record<string, unknown>).publicBaseUrl).toBe(
      "",
    );
    expect(
      (writtenJson.ingress as Record<string, unknown>).enabled,
    ).toBeUndefined();
    expect(
      (
        (writtenJson.skills as Record<string, unknown>).load as Record<
          string,
          unknown
        >
      ).extraDirs,
    ).toEqual([]);

    // Unrelated content is preserved verbatim.
    expect(writtenJson.unrelated).toBe("keep-me");
  });
});

describe("streamCommitImport — legacy USER.md skip on customized persona", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("skips writing prompts/USER.md when guardian persona is customized", async () => {
    // Seed the live workspace with a customized guardian persona file.
    // `isGuardianPersonaCustomized` inspects its content vs the bare
    // scaffold template; customized content must prevent the write.
    //
    // NOTE: the streaming importer uses an atomic temp-dir swap. The swap
    // REPLACES the entire live workspace with the temp workspace — so the
    // customized file at users/captain.md is expected to be gone after
    // import regardless (its contents are not re-materialized into the
    // temp tree). The behavior under test here is narrower: we verify
    // the legacy bundle's USER.md content was NEVER written into the
    // temp workspace's guardian path, and that the entry is reported as
    // `"skipped"` with a warning. This matches commitImport's semantics
    // for the legacy entry itself.
    const guardianPath = join(workspaceDir, "users", "captain.md");
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(guardianPath, CUSTOMIZED_PERSONA_FIXTURE, "utf8");

    const legacyContent = new TextEncoder().encode(
      "# Legacy bundle persona — should NOT be written over a customized file\n",
    );

    const resolver = new DefaultPathResolver(
      workspaceDir,
      undefined,
      () => guardianPath,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: legacyContent,
        },
        // Second entry ensures there's at least one workspace-targeted
        // write, so the atomic swap runs and we're exercising the skip
        // branch on the full flow rather than the no-swap short circuit.
        {
          path: "workspace/other.txt",
          data: new TextEncoder().encode("other content"),
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: resolver,
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // The other file in the bundle was written normally (proves the swap
    // happened — we're not accidentally hitting the no-swap short circuit).
    expect(readFileSync(join(workspaceDir, "other.txt"), "utf8")).toBe(
      "other content",
    );

    // Legacy content was NEVER written to the guardian target path. Because
    // the USER.md entry was skipped (not written into the temp tree) and
    // the swap replaces the entire workspace with the temp tree, the
    // guardian path should simply not exist after import.
    if (existsSync(guardianPath)) {
      // If something did write there, it must not be the bundle's legacy
      // content — that's the crucial regression to prevent.
      expect(readFileSync(guardianPath, "utf8")).not.toBe(
        new TextDecoder().decode(legacyContent),
      );
    } else {
      expect(existsSync(guardianPath)).toBe(false);
    }

    // The legacy entry is present in the report as "skipped".
    const legacyEntry = result.report.files.find(
      (f) => f.path === "prompts/USER.md",
    );
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry!.action).toBe("skipped");

    // A warning surfaces the skip reason.
    expect(
      result.report.warnings.some((w) => w.includes("prompts/USER.md")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carry-over parity: live workspace paths that the buffer-based importer
// preserves (data/db, data/qdrant, embedding-models, deprecated) must also
// survive the streaming importer's temp-dir atomic swap when the bundle
// does not carry them. Without this behavior, a partial bundle (e.g. one
// that only ships prompts + config) would wipe the user's SQLite DB and
// Qdrant vector store when imported through the streaming path.
// ---------------------------------------------------------------------------

describe("streamCommitImport — preserves live workspace paths when bundle omits them", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // Note: the prior "bundle omits data/db/*" preserve test was retired
  // when the v1 manifest schema started requiring `data/db/assistant.db`
  // (or its `workspace/`-prefixed counterpart) to be present. Under v1
  // every bundle declares the DB, so the bundle-omits-DB scenario is no
  // longer reachable through the public emit path.

  test("keeps the live data/qdrant/ directory when the bundle omits qdrant entries", async () => {
    // Populate a fake qdrant store with a nested file.
    mkdirSync(join(workspaceDir, "data", "qdrant", "segments"), {
      recursive: true,
    });
    const segmentBytes = Buffer.from("qdrant-segment-bytes");
    writeFileSync(
      join(workspaceDir, "data", "qdrant", "segments", "0.seg"),
      segmentBytes,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/config.json",
          data: new TextEncoder().encode("{}"),
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const postSegPath = join(
      workspaceDir,
      "data",
      "qdrant",
      "segments",
      "0.seg",
    );
    expect(existsSync(postSegPath)).toBe(true);
    expect(readFileSync(postSegPath)).toEqual(segmentBytes);
  });

  test("lets the bundle overwrite data/db when it does carry an assistant.db entry", async () => {
    // Seed the live workspace with OLD content so we can tell whether the
    // carry-over logic accidentally kept it instead of honoring the
    // bundle's new DB file.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "data", "db", "assistant.db"),
      "OLD-LIVE-DB",
    );

    const newDbBytes = new TextEncoder().encode("NEW-BUNDLE-DB");
    const { archive } = buildVBundle({
      files: [
        {
          path: "workspace/data/db/assistant.db",
          data: newDbBytes,
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const postDbPath = join(workspaceDir, "data", "db", "assistant.db");
    expect(readFileSync(postDbPath)).toEqual(Buffer.from(newDbBytes));
  });
});

// ---------------------------------------------------------------------------
// Gap A — legacy-only bundle (no `workspace/*` entries) writes each file in
// place WITHOUT triggering the atomic workspace swap. This matches
// commitImport's legacy branch: a `data/db/assistant.db`- or
// `config/settings.json`- style bundle preserves arbitrary live files
// outside WORKSPACE_PRESERVE_PATHS (where the swap path would have wiped
// them). Regression test for the self-review Gap A finding.
// ---------------------------------------------------------------------------

describe("streamCommitImport — legacy-only bundle writes in place", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("bundle carrying only `data/db/assistant.db` writes the DB in place and leaves unrelated live files untouched", async () => {
    // Seed the live workspace with BOTH a pre-existing `data/db/assistant.db`
    // (which the bundle will overwrite) AND an unrelated marker file at
    // top-level that is not in WORKSPACE_PRESERVE_PATHS — proving the old
    // atomic-swap path would have wiped it. Under the legacy-only branch
    // that file must survive.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "data", "db", "assistant.db"),
      "OLD-LIVE-DB",
    );
    writeFileSync(
      join(workspaceDir, "unrelated-top-level.txt"),
      "must-survive-legacy-import\n",
    );
    // A sibling directory — also outside preserve paths — that the atomic
    // swap would have wiped.
    mkdirSync(join(workspaceDir, "custom-user-dir"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "custom-user-dir", "note.md"),
      "custom note\n",
    );

    const newDbBytes = new TextEncoder().encode("NEW-LEGACY-BUNDLE-DB");
    const { archive } = buildVBundle({
      files: [
        {
          // Legacy archive path — NO `workspace/` prefix. This is what
          // older bundle exports produce.
          path: "data/db/assistant.db",
          data: newDbBytes,
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Bundle's DB landed at the right live location with the new bytes.
    const postDbPath = join(workspaceDir, "data", "db", "assistant.db");
    expect(readFileSync(postDbPath)).toEqual(Buffer.from(newDbBytes));

    // Unrelated live files still present — the atomic-swap path would
    // have wiped them. Their survival here proves we took the in-place
    // legacy branch.
    expect(
      readFileSync(join(workspaceDir, "unrelated-top-level.txt"), "utf8"),
    ).toBe("must-survive-legacy-import\n");
    expect(
      readFileSync(join(workspaceDir, "custom-user-dir", "note.md"), "utf8"),
    ).toBe("custom note\n");

    // The legacy entry is reported as "overwritten" (pre-existing DB),
    // with a backup path captured alongside.
    const dbEntry = result.report.files.find(
      (f) => f.path === "data/db/assistant.db",
    );
    expect(dbEntry).toBeDefined();
    expect(dbEntry!.action).toBe("overwritten");
    expect(dbEntry!.backup_path).not.toBeNull();
    // And the report summary reflects the same.
    expect(result.report.summary.files_overwritten).toBe(1);
    expect(result.report.summary.backups_created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap B — carry-over does per-file merge inside preserved directories.
// A bundle that writes ONE file under `workspace/data/qdrant/` must not
// cause the rest of the live `data/qdrant/` tree to be wiped by the
// atomic swap. Regression test for the self-review Gap B finding.
// ---------------------------------------------------------------------------

describe("streamCommitImport — preserved-path carry-over is per-file", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("bundle touching one file in data/qdrant/ does not wipe other live files in the same preserved dir", async () => {
    // Populate the live qdrant store with several nested files / dirs.
    // Only one of these paths overlaps with what the bundle will write;
    // the rest must survive the atomic swap via per-file carry-over.
    mkdirSync(join(workspaceDir, "data", "qdrant", "segments"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceDir, "data", "qdrant", "segments", "0.seg"),
      "seg-0-live",
    );
    writeFileSync(
      join(workspaceDir, "data", "qdrant", "segments", "1.seg"),
      "seg-1-live",
    );
    // A top-level file inside the preserved dir that the bundle will
    // overwrite.
    writeFileSync(
      join(workspaceDir, "data", "qdrant", "meta.json"),
      '{"stale":true}',
    );
    // A sibling directory the bundle never touches — must survive.
    mkdirSync(join(workspaceDir, "data", "qdrant", "wal"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceDir, "data", "qdrant", "wal", "wal-000"),
      "wal-entry",
    );

    // Bundle carries exactly ONE file under `data/qdrant/` AND at least
    // one other `workspace/*` entry so the atomic-swap path fires (not
    // the legacy in-place path).
    const newMeta = new TextEncoder().encode('{"fresh":true}');
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/qdrant/meta.json",
          data: newMeta,
        },
        {
          path: "workspace/marker.txt",
          data: new TextEncoder().encode("marker\n"),
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Bundle's overwrite landed.
    expect(
      readFileSync(join(workspaceDir, "data", "qdrant", "meta.json")),
    ).toEqual(Buffer.from(newMeta));

    // All the other live files in the preserved dir survived.
    expect(
      readFileSync(
        join(workspaceDir, "data", "qdrant", "segments", "0.seg"),
        "utf8",
      ),
    ).toBe("seg-0-live");
    expect(
      readFileSync(
        join(workspaceDir, "data", "qdrant", "segments", "1.seg"),
        "utf8",
      ),
    ).toBe("seg-1-live");
    expect(
      readFileSync(
        join(workspaceDir, "data", "qdrant", "wal", "wal-000"),
        "utf8",
      ),
    ).toBe("wal-entry");

    // And the workspace-targeted file outside the preserved dir landed.
    expect(readFileSync(join(workspaceDir, "marker.txt"), "utf8")).toBe(
      "marker\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Gap C — resource ceilings. Bundles declaring too many entries or too
// many bytes of data should abort with validation_failed before we commit
// anything to disk. Uses the test-only `maxBundleEntries` /
// `maxBundleBytes` knobs so we can exercise the abort with tiny
// fixtures. Regression test for the self-review Gap C finding.
// ---------------------------------------------------------------------------

describe("streamCommitImport — bundle resource ceilings", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Assert no sibling temp/backup dirs remain. */
  function assertNoLeftoverTempDirs(): void {
    const parent = join(workspaceDir, "..");
    const base = workspaceDir.split("/").pop()!;
    const siblings = readdirSync(parent);
    const leftover = siblings.filter(
      (name) =>
        name.startsWith(`${base}.import-`) ||
        name.startsWith(`${base}.pre-import-`),
    );
    expect(leftover).toEqual([]);
  }

  test("bundle declaring more entries than maxBundleEntries → validation_failed with bundle_too_many_entries", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    // Three small files — we'll set the cap to 2 so the manifest's
    // declared-count check trips before any tar entry is processed.
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        { path: "workspace/a.txt", data: new TextEncoder().encode("a") },
        { path: "workspace/b.txt", data: new TextEncoder().encode("b") },
        { path: "workspace/c.txt", data: new TextEncoder().encode("c") },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
      maxBundleEntries: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");
    if (result.reason !== "validation_failed") throw new Error("unreachable");
    expect(result.errors[0]!.code).toBe("bundle_too_many_entries");

    // Real workspace untouched, temp dir cleaned up.
    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });

  test("bundle exceeding maxBundleBytes → validation_failed with bundle_too_large", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "existing.txt"), "keep me\n");

    // Two files totaling 200 bytes of user data. Cap at 128 bytes so the
    // second file's streamed size pushes totalBytesStreamed over.
    const big = new Uint8Array(100).fill(0x41);
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        { path: "workspace/big1.bin", data: big },
        { path: "workspace/big2.bin", data: big },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
      maxBundleBytes: 128,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("validation_failed");
    if (result.reason !== "validation_failed") throw new Error("unreachable");
    expect(result.errors[0]!.code).toBe("bundle_too_large");

    expect(readFileSync(join(workspaceDir, "existing.txt"), "utf8")).toBe(
      "keep me\n",
    );
    assertNoLeftoverTempDirs();
  });
});

// ---------------------------------------------------------------------------
// Gap D — sanitized config reports sha256 of the BYTES ACTUALLY WRITTEN,
// not the manifest-declared sha of the raw archive content. commitImport
// already does this; the streaming importer regressed to reporting the
// manifest sha, so downstream integrity re-checks failed. Regression test
// for the self-review Gap D finding.
// ---------------------------------------------------------------------------

describe("streamCommitImport — report.sha256 reflects post-sanitization bytes", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("workspace/config.json report.sha256 equals sha256 of the on-disk sanitized bytes, not the raw archive sha", async () => {
    // Plant content that sanitizeConfigForTransfer will demonstrably
    // change (`daemon` is deleted, `ingress.publicBaseUrl` cleared, etc).
    // The raw archive bytes and the post-sanitization bytes therefore
    // differ — a correctly implemented importer reports the latter's sha.
    const tainted = JSON.stringify({
      daemon: { pid: 9999, host: "private.example.com" },
      ingress: { publicBaseUrl: "https://leak.example", enabled: true },
      unrelated: "keep-me",
    });
    const rawArchiveBytes = new TextEncoder().encode(tainted);
    const rawArchiveSha = sha256Hex(rawArchiveBytes);

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/config.json",
          data: rawArchiveBytes,
        },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const writtenPath = join(workspaceDir, "config.json");
    const onDiskBytes = readFileSync(writtenPath);
    const onDiskSha = sha256Hex(onDiskBytes);

    // Sanity: sanitization actually changed the bytes (otherwise the test
    // would be tautologically true).
    expect(onDiskSha).not.toBe(rawArchiveSha);

    const configEntry = result.report.files.find(
      (f) => f.path === "workspace/config.json",
    );
    expect(configEntry).toBeDefined();
    expect(configEntry!.sha256).toBe(onDiskSha);
    // Reported size is also the post-sanitization size, not raw.
    expect(configEntry!.size).toBe(onDiskBytes.length);
  });
});
