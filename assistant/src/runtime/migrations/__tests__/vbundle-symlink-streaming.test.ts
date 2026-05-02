/**
 * Tests for streaming-side symlink support in vbundle:
 *
 * - `parseVBundleStream` surfaces a hand-crafted typeflag-2 entry as
 *   `{ type: "symlink", linkname }`.
 * - `verifySymlinkEntry` accepts a well-formed symlink entry whose manifest
 *   declared a matching `link_target`.
 * - `verifySymlinkEntry` rejects a target that escapes the archive root with
 *   code `"symlink_target_escapes_archive"`.
 * - `verifySymlinkEntry` rejects a manifest/tar disagreement with code
 *   `"link_target_mismatch"`.
 * - End-to-end round-trip via `buildVBundle({ files: [{ linkTarget }] })`:
 *   the in-memory builder emits a typeflag-2 record that survives
 *   `parseVBundleStream` and is accepted by `verifySymlinkEntry`.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  readAndValidateManifest,
  StreamingValidationError,
  verifySymlinkEntry,
} from "../vbundle-streaming-validator.js";
import {
  parseVBundleStream,
  type StreamedTarEntry,
} from "../vbundle-tar-stream.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Hand-crafted tar fixture helpers
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function writeOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const str = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  buf[offset + length - 1] = 0;
}

/**
 * Build a single 512-byte tar header block with typeflag-2 (symlink). The
 * link target is written into the linkname field (header[157..256]). Body
 * size is always 0 for symlink entries so no content blocks follow.
 */
function buildSymlinkHeaderBlock(name: string, linkTarget: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const linkBytes = encoder.encode(linkTarget);
  if (nameBytes.length > 100) {
    throw new Error(`fixture: name too long (${nameBytes.length} bytes)`);
  }
  if (linkBytes.length > 100) {
    throw new Error(`fixture: linkTarget too long (${linkBytes.length} bytes)`);
  }

  const header = new Uint8Array(BLOCK_SIZE);
  header.set(nameBytes, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, 0); // size=0
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header[156] = "2".charCodeAt(0); // typeflag = symlink
  header.set(linkBytes, 157); // linkname

  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Checksum: sum of all bytes with the checksum field treated as 8 ASCII spaces.
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  writeOctal(header, 148, 7, sum);
  header[155] = 0x20;

  return header;
}

/** Concatenate a list of byte chunks into a single Uint8Array. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Build a minimal gzipped tar archive containing a single typeflag-2 entry
 * followed by the standard two-block end-of-archive marker. Used for
 * exercising the parser without depending on `buildVBundle` symlink emit
 * (which lands in PR 2).
 */
function buildGzippedSymlinkOnlyTar(
  name: string,
  linkTarget: string,
): Uint8Array {
  const tar = concatBytes([
    buildSymlinkHeaderBlock(name, linkTarget),
    new Uint8Array(BLOCK_SIZE * 2), // EOA marker
  ]);
  return gzipSync(tar);
}

function readableFromBuffer(buf: Uint8Array): Readable {
  return Readable.from([Buffer.from(buf)]);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build a synthetic `StreamedTarEntry` for use with `verifySymlinkEntry`.
 * The body is empty (`Readable.from([])`) since symlink entries declare
 * size=0 and never carry payload bytes.
 */
function makeSymlinkEntry(input: {
  name: string;
  linkname: string;
  size?: number;
}): StreamedTarEntry {
  return {
    header: {
      name: input.name,
      size: input.size ?? 0,
      type: "symlink",
      linkname: input.linkname,
    },
    body: Readable.from([]),
  };
}

// ---------------------------------------------------------------------------
// parseVBundleStream — surfaces typeflag-2 entries
// ---------------------------------------------------------------------------

describe("parseVBundleStream — symlink entries", () => {
  test("surfaces a typeflag-2 entry as { type: 'symlink', linkname }", async () => {
    const archive = buildGzippedSymlinkOnlyTar("workspace/foo.md", "bar.md");

    const seen: { name: string; type: string; linkname?: string }[] = [];
    for await (const entry of parseVBundleStream(readableFromBuffer(archive))) {
      seen.push({
        name: entry.header.name,
        type: entry.header.type,
        linkname: entry.header.linkname,
      });
      // Drain the (zero-byte) body so the extractor advances.
      entry.body.resume();
    }

    expect(seen.length).toBe(1);
    expect(seen[0]?.name).toBe("workspace/foo.md");
    expect(seen[0]?.type).toBe("symlink");
    expect(seen[0]?.linkname).toBe("bar.md");
  });
});

// ---------------------------------------------------------------------------
// verifySymlinkEntry — happy path
// ---------------------------------------------------------------------------

describe("verifySymlinkEntry — accepts a valid symlink", () => {
  test("does not throw when manifest and tar agree and target stays in archive", () => {
    const linkTarget = "bar.md";
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: linkTarget,
    });

    expect(() =>
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(linkTarget),
          size: 0,
          linkTarget,
        },
      }),
    ).not.toThrow();
  });

  test("accepts a target that resolves to a sibling at the archive root", () => {
    const linkTarget = "sibling.md";
    const entry = makeSymlinkEntry({
      name: "workspace/notes/foo.md",
      linkname: linkTarget,
    });

    expect(() =>
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(linkTarget),
          size: 0,
          linkTarget,
        },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifySymlinkEntry — path traversal rejection
// ---------------------------------------------------------------------------

describe("verifySymlinkEntry — path traversal", () => {
  test("rejects a target that escapes the archive root with code symlink_target_escapes_archive", () => {
    const escapingTarget = "../../../etc/passwd";
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: escapingTarget,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(escapingTarget),
          size: 0,
          linkTarget: escapingTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("symlink_target_escapes_archive");
    expect(err?.archivePath).toBe("workspace/foo.md");
  });

  test("verifySymlinkEntry rejects absolute symlink targets", () => {
    // Regression: `posix.join("workspace", "/etc/passwd")` normalizes the
    // leading slash away and returns `"workspace/etc/passwd"`, so without
    // an explicit absolute-target guard an attacker could ship a manifest
    // with `link_target: "/etc/passwd"` that passes the `..` traversal
    // check and is later realized by `fs.symlink("/etc/passwd", ...)`.
    const absoluteTarget = "/etc/passwd";
    const entry = makeSymlinkEntry({
      name: "workspace/skills/foo.md",
      linkname: absoluteTarget,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(absoluteTarget),
          size: 0,
          linkTarget: absoluteTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("symlink_target_escapes_archive");
    expect(err?.archivePath).toBe("workspace/skills/foo.md");
  });

  test("rejects a target that escapes the archive root from a top-level symlink", () => {
    // Symlink at "foo.md" (no parent dir inside the archive); a `..` target
    // resolves above the archive root.
    const escapingTarget = "..";
    const entry = makeSymlinkEntry({
      name: "foo.md",
      linkname: escapingTarget,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(escapingTarget),
          size: 0,
          linkTarget: escapingTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("symlink_target_escapes_archive");
  });
});

// ---------------------------------------------------------------------------
// verifySymlinkEntry — manifest/tar disagreement
// ---------------------------------------------------------------------------

describe("verifySymlinkEntry — disagreement", () => {
  test("throws link_target_mismatch when tar linkname differs from manifest link_target", () => {
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: "bar.md",
    });
    const manifestTarget = "qux.md";

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(manifestTarget),
          size: 0,
          linkTarget: manifestTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("link_target_mismatch");
    expect(err?.archivePath).toBe("workspace/foo.md");
  });

  test("throws symlink_not_declared when manifest entry has no link_target", () => {
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: "bar.md",
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex("bar.md"),
          size: 0,
          linkTarget: null,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("symlink_not_declared");
  });

  test("throws entry_size when symlink header declares non-zero size", () => {
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: "bar.md",
      size: 5,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex("bar.md"),
          size: 0,
          linkTarget: "bar.md",
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("entry_size");
  });

  test("throws entry_size when manifest declares non-zero size_bytes for a symlink", () => {
    // The buffered validator catches manifest size_bytes != 0 for symlink
    // entries via FILE_SIZE_MISMATCH. Streaming side must reject the same
    // crafted shape — a manifest with `link_target` plus `size_bytes: 100`
    // would otherwise slip past `verifySymlinkEntry` (which only checked
    // tar header.size).
    const linkTarget = "bar.md";
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: linkTarget,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          sha256: sha256Hex(linkTarget),
          size: 100,
          linkTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("entry_size");
    expect(err?.archivePath).toBe("workspace/foo.md");
  });

  test("throws entry_hash when manifest sha256 doesn't match link target digest", () => {
    const linkTarget = "bar.md";
    const entry = makeSymlinkEntry({
      name: "workspace/foo.md",
      linkname: linkTarget,
    });

    let err: StreamingValidationError | null = null;
    try {
      verifySymlinkEntry({
        entry,
        expectedEntry: {
          // Wrong digest — manifest declared a different content than what's
          // hashable from the link target.
          sha256:
            "0000000000000000000000000000000000000000000000000000000000000000",
          size: 0,
          linkTarget,
        },
      });
    } catch (e) {
      err = e as StreamingValidationError;
    }

    expect(err).toBeInstanceOf(StreamingValidationError);
    expect(err?.code).toBe("entry_hash");
  });
});

// ---------------------------------------------------------------------------
// Round-trip via buildVBundle
// ---------------------------------------------------------------------------

describe("round-trip: buildVBundle -> parseVBundleStream -> verifySymlinkEntry", () => {
  test("a symlink entry survives the full streaming pipeline", async () => {
    const linkTarget = "bar.md";
    const regularFileBytes = new TextEncoder().encode("regular file payload\n");

    const { archive } = buildVBundle({
      files: [
        // The streaming importer requires data/db/assistant.db to be present;
        // include a synthetic empty one so this fixture mirrors what
        // production exports always carry.
        { path: "data/db/assistant.db", data: new Uint8Array() },
        // A regular file entry so we exercise both shapes through the parser.
        { path: "workspace/regular.md", data: regularFileBytes },
        // The symlink under test.
        { path: "workspace/foo.md", data: new Uint8Array(), linkTarget },
      ],
      ...defaultV1Options(),
    });

    const iter = parseVBundleStream(readableFromBuffer(archive));

    // The manifest is the FIRST tar entry and must be drained before
    // subsequent entries flow through.
    const manifestEntry = await iter.next();
    if (manifestEntry.done || !manifestEntry.value) {
      throw new Error("archive contained no entries");
    }
    const { expected } = await readAndValidateManifest(manifestEntry.value);

    // Drain the rest of the entries and capture the symlink entry.
    let symlinkEntry: StreamedTarEntry | null = null;
    for await (const entry of iter) {
      if (entry.header.name === "workspace/foo.md") {
        symlinkEntry = entry;
        // Confirm the parser surfaced the typeflag-2 record correctly before
        // handing it to verifySymlinkEntry (which would also resume() the
        // body on its own paths).
        expect(entry.header.type).toBe("symlink");
        expect(entry.header.linkname).toBe(linkTarget);

        const expectedEntry = expected.get("workspace/foo.md");
        if (!expectedEntry) {
          throw new Error("manifest expected map missing the symlink entry");
        }
        expect(expectedEntry.linkTarget).toBe(linkTarget);

        // Asserts streaming-validator acceptance of a builder-produced entry.
        expect(() =>
          verifySymlinkEntry({ entry, expectedEntry }),
        ).not.toThrow();
      } else {
        // Drain non-symlink bodies so the extractor advances.
        entry.body.resume();
      }
    }

    expect(symlinkEntry).not.toBeNull();
  });
});
