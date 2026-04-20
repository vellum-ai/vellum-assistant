/**
 * Tests for `parseVBundleStream` — the streaming tar reader for `.vbundle`
 * archives.
 *
 * Covered:
 * - Happy path: 3-file archive yields entries in order with correct names/sizes.
 * - Manifest-first invariant: first entry is `manifest.json`.
 * - Truncated gzip mid-stream: generator throws.
 * - Valid gzip but malformed tar payload: generator throws.
 * - Early termination (break in for-await loop): upstream source is destroyed.
 */

import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  parseVBundleStream,
  type StreamedTarEntry,
} from "../vbundle-tar-stream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectBody(entry: StreamedTarEntry): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of entry.body) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function readableFromBuffer(buf: Uint8Array): Readable {
  // `Readable.from(Uint8Array)` iterates byte-by-byte (each element becomes
  // a chunk), which is not what we want here. Wrap in an array so the whole
  // buffer arrives as a single chunk — closer to how the HTTP client will
  // feed bytes in production.
  return Readable.from([Buffer.from(buf)]);
}

/** Build a minimal vbundle archive with the given extra files (plus manifest). */
function buildMinimalVBundle(
  extraFiles: { path: string; data: Uint8Array }[],
): Uint8Array {
  const { archive } = buildVBundle({
    files: extraFiles,
    source: "test",
    description: "test bundle",
  });
  return archive;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("parseVBundleStream — happy path", () => {
  test("yields entries in order with correct names and sizes", async () => {
    const fileA = new TextEncoder().encode("alpha\n");
    const fileB = new TextEncoder().encode("beta beta\n");
    const fileC = new TextEncoder().encode("gamma gamma gamma\n");

    const archive = buildMinimalVBundle([
      { path: "workspace/a.txt", data: fileA },
      { path: "workspace/b.txt", data: fileB },
      { path: "workspace/c.txt", data: fileC },
    ]);

    const source = readableFromBuffer(archive);
    const seen: { name: string; size: number; body: Uint8Array }[] = [];

    for await (const entry of parseVBundleStream(source)) {
      const body = await collectBody(entry);
      seen.push({
        name: entry.header.name,
        size: entry.header.size,
        body,
      });
    }

    // manifest.json is emitted first, then the 3 files in insertion order.
    expect(seen.length).toBe(4);
    expect(seen[0]?.name).toBe("manifest.json");
    expect(seen[1]?.name).toBe("workspace/a.txt");
    expect(seen[2]?.name).toBe("workspace/b.txt");
    expect(seen[3]?.name).toBe("workspace/c.txt");

    // Sizes in the header match the body lengths.
    expect(seen[1]?.size).toBe(fileA.length);
    expect(seen[1]?.body.length).toBe(fileA.length);
    expect(seen[2]?.size).toBe(fileB.length);
    expect(seen[2]?.body.length).toBe(fileB.length);
    expect(seen[3]?.size).toBe(fileC.length);
    expect(seen[3]?.body.length).toBe(fileC.length);

    // Body contents round-trip correctly.
    expect(new TextDecoder().decode(seen[1]?.body)).toBe("alpha\n");
    expect(new TextDecoder().decode(seen[2]?.body)).toBe("beta beta\n");
    expect(new TextDecoder().decode(seen[3]?.body)).toBe("gamma gamma gamma\n");
  });
});

// ---------------------------------------------------------------------------
// Manifest-first invariant
// ---------------------------------------------------------------------------

describe("parseVBundleStream — manifest-first", () => {
  test("first entry is manifest.json", async () => {
    const archive = buildMinimalVBundle([
      { path: "z-last.txt", data: new TextEncoder().encode("zzz") },
    ]);

    const iter = parseVBundleStream(readableFromBuffer(archive));
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value?.header.name).toBe("manifest.json");
    expect(first.value?.header.type).toBe("file");

    // Drain the manifest body so the iterator can advance, then finish.
    if (first.value) await collectBody(first.value);
    // Exhaust the iterator to release resources. Drain each body so the
    // extractor can advance. (We don't assert on the remaining entries here.)
    for await (const entry of iter) {
      await collectBody(entry);
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("parseVBundleStream — errors", () => {
  test("throws on truncated gzip mid-stream", async () => {
    const archive = buildMinimalVBundle([
      { path: "workspace/a.txt", data: new TextEncoder().encode("hello") },
    ]);

    // Lop off the trailing bytes of the gzip member so the decoder fails
    // partway through.
    const truncated = archive.subarray(0, Math.max(32, archive.length - 20));
    const source = readableFromBuffer(new Uint8Array(truncated));

    let threw = false;
    try {
      for await (const entry of parseVBundleStream(source)) {
        // Drain whatever the decoder can produce before the error hits.
        try {
          await collectBody(entry);
        } catch {
          // Body streams may error mid-drain; that also counts as a failure
          // in the outer iterator on the next advance.
          threw = true;
          break;
        }
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });

  test("throws on valid gzip wrapping malformed tar bytes", async () => {
    // Gzipped junk — valid gzip member, but the inflated bytes aren't a tar.
    const junk = new TextEncoder().encode("this is not a tar archive payload");
    // Pad out so the extractor has enough bytes to attempt a header parse.
    const padded = new Uint8Array(1024);
    padded.set(junk, 0);
    const gz = gzipSync(padded);
    const source = readableFromBuffer(new Uint8Array(gz));

    let threw = false;
    try {
      for await (const entry of parseVBundleStream(source)) {
        try {
          await collectBody(entry);
        } catch {
          threw = true;
          break;
        }
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Early-termination cleanup
// ---------------------------------------------------------------------------

describe("parseVBundleStream — cleanup", () => {
  test("destroys upstream source when caller breaks out of the loop", async () => {
    const archive = buildMinimalVBundle([
      { path: "workspace/a.txt", data: new TextEncoder().encode("hello") },
      { path: "workspace/b.txt", data: new TextEncoder().encode("world") },
    ]);

    const source = readableFromBuffer(archive);
    let destroyCalls = 0;
    const originalDestroy = source.destroy.bind(source);
    source.destroy = ((err?: Error) => {
      destroyCalls += 1;
      return originalDestroy(err);
    }) as typeof source.destroy;

    for await (const entry of parseVBundleStream(source)) {
      // Consume just the first entry (manifest.json), then bail.
      await collectBody(entry);
      break;
    }

    expect(destroyCalls).toBeGreaterThan(0);
    // Source should now be destroyed (no dangling listeners keeping it alive).
    expect(source.destroyed).toBe(true);
  });
});
