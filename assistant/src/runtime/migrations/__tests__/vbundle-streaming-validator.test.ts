/**
 * Tests for the streaming validator primitives:
 * - `readAndValidateManifest` consumes the first tar entry and runs the
 *   full manifest validation pipeline.
 * - `createHashVerifier` is a passthrough Transform that aborts with a
 *   typed error on digest/size mismatch.
 *
 * Happy-path fixtures are built with the existing `buildVBundle` helper.
 * Negative-path fixtures (non-manifest first, oversize manifest, malformed
 * JSON, schema fail, sha mismatch) are hand-constructed because
 * `buildVBundle` always produces valid, manifest-first archives.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  createHashVerifier,
  readAndValidateManifest,
  StreamingValidationError,
} from "../vbundle-streaming-validator.js";
import {
  parseVBundleStream,
  type StreamedTarEntry,
} from "../vbundle-tar-stream.js";
import {
  computeLegacyManifestSha256,
  computeManifestChecksum,
} from "../vbundle-validator.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function readableFromBuffer(buf: Uint8Array): Readable {
  return Readable.from([Buffer.from(buf)]);
}

/** Minimal hand-rolled tar entry builder (ustar regular file). */
function buildTarEntry(name: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 100) {
    throw new Error(`test helper: name too long (${nameBytes.length} bytes)`);
  }

  const header = new Uint8Array(BLOCK_SIZE);
  header.set(nameBytes, 0);

  const writeOctal = (offset: number, length: number, value: number) => {
    const str = value.toString(8).padStart(length - 1, "0");
    for (let i = 0; i < str.length; i++) {
      header[offset + i] = str.charCodeAt(i);
    }
    header[offset + length - 1] = 0;
  };

  writeOctal(100, 8, 0o644); // mode
  writeOctal(108, 8, 0); // uid
  writeOctal(116, 8, 0); // gid
  writeOctal(124, 12, data.length); // size
  writeOctal(136, 12, Math.floor(Date.now() / 1000)); // mtime
  header[156] = "0".charCodeAt(0); // typeflag = regular file

  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Header checksum: sum of all bytes with the checksum field treated
  // as 8 ASCII spaces.
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  writeOctal(148, 7, sum);
  header[155] = 0x20;

  // Pad data out to the next 512-byte boundary.
  const remainder = data.length % BLOCK_SIZE;
  const padded =
    remainder === 0
      ? data
      : (() => {
          const out = new Uint8Array(data.length + (BLOCK_SIZE - remainder));
          out.set(data, 0);
          return out;
        })();

  const entry = new Uint8Array(header.length + padded.length);
  entry.set(header, 0);
  entry.set(padded, header.length);
  return entry;
}

/** Hand-build a gzipped tar archive from the given entries (no manifest injected). */
function buildRawVBundle(
  entries: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = entries.map((e) => buildTarEntry(e.name, e.data));
  // End-of-archive marker: two zero blocks.
  parts.push(new Uint8Array(BLOCK_SIZE * 2));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    tar.set(p, offset);
    offset += p.length;
  }
  return gzipSync(tar);
}

/** Fetch the first entry of a streaming archive; drain+close the iterator after. */
async function firstEntryOf(
  archive: Uint8Array,
): Promise<{ entry: StreamedTarEntry; drainRest: () => Promise<void> }> {
  const iter = parseVBundleStream(readableFromBuffer(archive));
  const first = await iter.next();
  if (first.done || !first.value) {
    throw new Error("archive contained no entries");
  }
  const drainRest = async () => {
    for await (const rest of iter) {
      rest.body.resume();
    }
  };
  return { entry: first.value, drainRest };
}

// ---------------------------------------------------------------------------
// readAndValidateManifest — happy path
// ---------------------------------------------------------------------------

describe("readAndValidateManifest — happy path", () => {
  test("parses manifest and populates expected map from manifest.contents", async () => {
    const fileA = new TextEncoder().encode("alpha payload\n");
    const fileB = new TextEncoder().encode("beta payload\n");
    const { archive, manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        { path: "workspace/a.txt", data: fileA },
        { path: "workspace/b.txt", data: fileB },
      ],
      ...defaultV1Options(),
    });

    const { entry, drainRest } = await firstEntryOf(archive);
    const result = await readAndValidateManifest(entry);
    await drainRest();

    expect(result.manifest.schema_version).toBe(manifest.schema_version);
    // Includes the synthetic data/db/assistant.db entry plus a/b.txt.
    expect(result.manifest.contents).toHaveLength(3);
    expect(result.manifest.checksum).toBe(manifest.checksum);

    expect(result.expected.size).toBe(3);
    const expectA = result.expected.get("workspace/a.txt");
    expect(expectA?.size).toBe(fileA.length);
    expect(expectA?.sha256).toBe(
      manifest.contents.find((f) => f.path === "workspace/a.txt")?.sha256,
    );
    const expectB = result.expected.get("workspace/b.txt");
    expect(expectB?.size).toBe(fileB.length);
    expect(expectB?.sha256).toBe(
      manifest.contents.find((f) => f.path === "workspace/b.txt")?.sha256,
    );
  });
});

// ---------------------------------------------------------------------------
// readAndValidateManifest — negative paths
// ---------------------------------------------------------------------------

describe("readAndValidateManifest — negative paths", () => {
  test("throws manifest_not_first when first entry is not manifest.json", async () => {
    const archive = buildRawVBundle([
      { name: "workspace/a.txt", data: new TextEncoder().encode("hello") },
    ]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_not_first");
  });

  test("throws manifest_too_large and fails fast before draining the whole body", async () => {
    // Fake a tar entry whose body would emit 5 MiB if fully drained. The
    // validator must destroy() the stream and throw the moment the running
    // byte count crosses the 1 MiB cap — it must NOT keep pulling chunks.
    //
    // We count bytes emitted via a _read implementation, and after the
    // throw assert both that destroy() fired and that far fewer than 5 MiB
    // were ever pulled out of the stream.
    const CHUNK = 512 * 1024; // 512 KiB
    const TOTAL_CHUNKS = 10; // 5 MiB worth — way past the 1 MiB cap
    let chunksEmitted = 0;
    let bytesEmitted = 0;
    const body = new Readable({
      read() {
        if (chunksEmitted >= TOTAL_CHUNKS) {
          this.push(null);
          return;
        }
        const buf = Buffer.alloc(CHUNK, 0x20);
        chunksEmitted += 1;
        bytesEmitted += buf.length;
        this.push(buf);
      },
    });

    const entry: StreamedTarEntry = {
      header: {
        name: "manifest.json",
        size: CHUNK * TOTAL_CHUNKS,
        type: "file",
      },
      body,
    };

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_too_large");
    // Fail-fast assertions: destroy() was called, and we didn't drain past
    // ~1 MiB + one chunk. If the validator had drained to EOF we'd see the
    // full 5 MiB / 10 chunks here.
    expect(body.destroyed).toBe(true);
    expect(chunksEmitted).toBeLessThanOrEqual(3);
    expect(bytesEmitted).toBeLessThan(2 * 1024 * 1024);
  });

  test("throws manifest_malformed when manifest body is not valid JSON", async () => {
    const archive = buildRawVBundle([
      { name: "manifest.json", data: new TextEncoder().encode("{not-json") },
    ]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_malformed");
  });

  test("throws manifest_schema when a required field is missing", async () => {
    // Valid JSON but missing `files`, `manifest_sha256`, etc.
    const bogus = new TextEncoder().encode(
      JSON.stringify({ schema_version: "1.0", created_at: "now" }),
    );
    const archive = buildRawVBundle([{ name: "manifest.json", data: bogus }]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_schema");
  });

  test("throws manifest_sha256 when the declared digest doesn't match canonical JSON", async () => {
    const badManifest = {
      schema_version: 1,
      bundle_id: "00000000-0000-4000-8000-000000000000",
      created_at: new Date().toISOString(),
      assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
      origin: { mode: "self-hosted-local" },
      compatibility: {
        min_runtime_version: "0.0.0-test",
        max_runtime_version: null,
      },
      contents: [
        {
          path: "data/db/assistant.db",
          sha256:
            "1111111111111111111111111111111111111111111111111111111111111111",
          size_bytes: 10,
        },
      ],
      // Deliberately wrong digest. The canonical hash of a v1 manifest
      // won't match this, regardless of ordering.
      checksum:
        "0000000000000000000000000000000000000000000000000000000000000000",
      secrets_redacted: false,
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
    };
    const archive = buildRawVBundle([
      {
        name: "manifest.json",
        data: new TextEncoder().encode(JSON.stringify(badManifest)),
      },
    ]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_sha256");
  });

  test("throws manifest_duplicate_path when the same archive path appears twice", async () => {
    const baseManifest = {
      schema_version: 1,
      bundle_id: "00000000-0000-4000-8000-000000000001",
      created_at: new Date().toISOString(),
      assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
      origin: { mode: "self-hosted-local" },
      compatibility: {
        min_runtime_version: "0.0.0-test",
        max_runtime_version: null,
      },
      contents: [
        {
          path: "data/db/assistant.db",
          sha256:
            "1111111111111111111111111111111111111111111111111111111111111111",
          size_bytes: 10,
        },
        {
          // Deliberately duplicate path — malicious bundle could exploit
          // this to bypass per-entry integrity checks if we silently
          // collapsed.
          path: "data/db/assistant.db",
          sha256:
            "2222222222222222222222222222222222222222222222222222222222222222",
          size_bytes: 20,
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
    baseManifest.checksum = computeManifestChecksum(baseManifest);

    const archive = buildRawVBundle([
      {
        name: "manifest.json",
        data: new TextEncoder().encode(JSON.stringify(baseManifest)),
      },
    ]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_duplicate_path");
    expect(err?.message).toContain("data/db/assistant.db");
  });
});

// ---------------------------------------------------------------------------
// createHashVerifier
// ---------------------------------------------------------------------------

describe("createHashVerifier — identity + integrity", () => {
  const payload = Buffer.from(
    "the quick brown fox jumps over the lazy dog".repeat(100),
    "utf8",
  );
  // Precomputed digest for the payload above.
  const payloadSha = createHash("sha256").update(payload).digest("hex");

  test("is an identity Transform for correct inputs", async () => {
    const verifier = createHashVerifier({
      sha256: payloadSha,
      size: payload.length,
      archivePath: "workspace/ok.txt",
    });

    // Feed the payload in two chunks to exercise multi-call _transform.
    const half = payload.length >>> 1;
    const source = Readable.from([
      payload.subarray(0, half),
      payload.subarray(half),
    ]);

    const collected: Buffer[] = [];
    verifier.on("data", (chunk: Buffer) => collected.push(chunk));

    await pipeline(source, verifier);

    const out = Buffer.concat(collected);
    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
  });

  test("errors with code entry_hash on digest mismatch", async () => {
    const verifier = createHashVerifier({
      sha256:
        // Wrong digest.
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      size: payload.length,
      archivePath: "workspace/bad-hash.txt",
    });

    let err: StreamingValidationError | null = null;
    try {
      await pipeline(
        Readable.from([payload]),
        verifier,
        async function* (source: AsyncIterable<Buffer>) {
          // Drain the transform so _flush runs.
          for await (const _chunk of source) {
            // discard
          }
        },
      );
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("entry_hash");
    expect(err?.archivePath).toBe("workspace/bad-hash.txt");
  });

  test("errors with code entry_size on byte-count mismatch", async () => {
    // Right digest, wrong declared size.
    const verifier = createHashVerifier({
      sha256: payloadSha,
      size: payload.length + 1,
      archivePath: "workspace/bad-size.txt",
    });

    let err: StreamingValidationError | null = null;
    try {
      await pipeline(
        Readable.from([payload]),
        verifier,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const _chunk of source) {
            // discard
          }
        },
      );
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("entry_size");
    expect(err?.archivePath).toBe("workspace/bad-size.txt");
  });
});

// ---------------------------------------------------------------------------
// readAndValidateManifest — legacy fallback (backwards compatibility)
// ---------------------------------------------------------------------------

describe("readAndValidateManifest — legacy fallback", () => {
  test("accepts a valid legacy six-field manifest and translates to v1 shape", async () => {
    const dbBytes = new TextEncoder().encode("legacy-db");
    const dbSha = createHash("sha256").update(dbBytes).digest("hex");

    const legacyManifest: Record<string, unknown> = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      source: "runtime-export",
      description: "legacy fixture",
      files: [
        { path: "data/db/assistant.db", sha256: dbSha, size: dbBytes.length },
      ],
      manifest_sha256: "",
    };
    legacyManifest.manifest_sha256 =
      computeLegacyManifestSha256(legacyManifest);

    const archive = buildRawVBundle([
      {
        name: "manifest.json",
        data: new TextEncoder().encode(JSON.stringify(legacyManifest)),
      },
      { name: "data/db/assistant.db", data: dbBytes },
    ]);

    const { entry, drainRest } = await firstEntryOf(archive);
    const result = await readAndValidateManifest(entry);
    await drainRest();

    expect(result.manifest.schema_version).toBe(1);
    expect(result.manifest.contents).toHaveLength(1);
    expect(result.manifest.contents[0]?.path).toBe("data/db/assistant.db");
    expect(result.manifest.contents[0]?.size_bytes).toBe(dbBytes.length);
    expect(result.expected.get("data/db/assistant.db")?.sha256).toBe(dbSha);
  });

  test("throws manifest_sha256 on a legacy manifest with a wrong checksum", async () => {
    const dbBytes = new TextEncoder().encode("legacy-db");
    const dbSha = createHash("sha256").update(dbBytes).digest("hex");

    const badLegacy = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        { path: "data/db/assistant.db", sha256: dbSha, size: dbBytes.length },
      ],
      // Deliberately wrong checksum.
      manifest_sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const archive = buildRawVBundle([
      {
        name: "manifest.json",
        data: new TextEncoder().encode(JSON.stringify(badLegacy)),
      },
    ]);
    const { entry, drainRest } = await firstEntryOf(archive);

    let err: StreamingValidationError | null = null;
    try {
      await readAndValidateManifest(entry);
    } catch (e) {
      err = e as StreamingValidationError;
    }
    await drainRest();

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("manifest_sha256");
  });
});
