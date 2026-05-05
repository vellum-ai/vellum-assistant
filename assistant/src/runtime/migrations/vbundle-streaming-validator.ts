/**
 * Streaming validation primitives for `.vbundle` archives.
 *
 * The non-streaming `validateVBundle` decompresses the entire archive into
 * memory and walks the tar buffer to compute per-file SHA-256s. That is fine
 * for small bundles but peaks at 2x the decompressed size in RAM — an 8 GB
 * bundle OOMs a 3 GB pod.
 *
 * This module lets a caller validate a bundle while streaming:
 * - `readAndValidateManifest` consumes the first tar entry (which must be
 *   `manifest.json`), validates the schema, and verifies the self-referencing
 *   `checksum` against the canonicalized JSON.
 * - `createHashVerifier` returns a passthrough `Transform` that hashes bytes
 *   flowing through it and errors the pipeline if the final digest or byte
 *   count does not match the expected values from the manifest.
 *
 * Together, these let a consumer pipe every subsequent tar entry through a
 * hash verifier before writing it to disk, without ever buffering the full
 * bundle.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Transform, type TransformCallback } from "node:stream";

import type { StreamedTarEntry } from "./vbundle-tar-stream.js";
import {
  computeLegacyManifestSha256,
  computeManifestChecksum,
  LegacyManifestSchema,
  ManifestSchema,
  type ManifestType,
  translateLegacyManifest,
} from "./vbundle-validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestReadResult {
  manifest: ManifestType;
  /**
   * Fast lookup from archive path -> expected sha256 + size + linkTarget
   * (from manifest.contents). `linkTarget` is non-null only for symlink
   * entries — regular file entries carry `null` so callers can branch on
   * type without a separate map.
   */
  expected: Map<
    string,
    { sha256: string; size: number; linkTarget: string | null }
  >;
}

/**
 * All failure modes produced by this module. Every throw/error includes a
 * stable `code` string so callers can branch on the failure kind without
 * string-matching the message.
 */
export class StreamingValidationError extends Error {
  public readonly code: string;
  public readonly archivePath?: string;

  constructor(code: string, message: string, archivePath?: string) {
    super(message);
    this.name = "StreamingValidationError";
    this.code = code;
    if (archivePath !== undefined) {
      this.archivePath = archivePath;
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

// Manifests are metadata only — typically tens to hundreds of KB even for
// huge bundles. A 1 MiB cap is comfortably above realistic sizes and
// protects against a malicious archive whose "manifest" is actually a
// multi-GB stream intended to OOM the validator.
const MANIFEST_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Drain the first tar entry — which MUST be `manifest.json` — and run the
 * full manifest-level validation pipeline:
 *   1. Entry name check.
 *   2. Size cap (1 MiB).
 *   3. JSON parse.
 *   4. Zod schema validation.
 *   5. Self-referencing `checksum` verification against the
 *      canonicalized JSON (minus that field).
 *
 * On success, returns the parsed manifest plus a `Map` keyed by archive
 * path that callers consult as each subsequent entry streams past.
 *
 * On failure, throws a `StreamingValidationError` with a distinct `code`
 * for every failure mode.
 */
export async function readAndValidateManifest(
  first: StreamedTarEntry,
): Promise<ManifestReadResult> {
  if (first.header.name !== "manifest.json") {
    // Drain the body so the underlying tar extractor isn't left dangling
    // on backpressure before the caller reports the error.
    first.body.resume();
    throw new StreamingValidationError(
      "manifest_not_first",
      `Expected manifest.json as the first tar entry, got "${first.header.name}"`,
    );
  }

  // Drain the entry body into a Buffer, enforcing the size cap as we go.
  // The moment we cross the cap we destroy the entry stream — this signals
  // the tar extractor (and therefore gunzip + upstream source) to abort,
  // so a malicious archive whose "manifest" is a multi-GB decompressed
  // stream can't force us to read through all of it before rejecting.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of first.body) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MANIFEST_MAX_BYTES) {
      first.body.destroy();
      throw new StreamingValidationError(
        "manifest_too_large",
        `manifest.json exceeds ${MANIFEST_MAX_BYTES} byte limit (read ${total} bytes before aborting)`,
      );
    }
    chunks.push(buf);
  }

  const bodyBuf = Buffer.concat(chunks, total);

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(bodyBuf.toString("utf8"));
  } catch (err) {
    throw new StreamingValidationError(
      "manifest_malformed",
      `manifest.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Try the v1 schema first; fall back to the legacy six-field shape so
  // existing on-disk bundles (backup snapshots, cross-version migrations)
  // keep streaming-validating after upgrade. AGENTS.md prohibits silent
  // breaks of persisted state.
  const parseResult = ManifestSchema.safeParse(manifestRaw);
  let manifest: ManifestType;

  if (parseResult.success) {
    manifest = parseResult.data;
    // Recompute the self-referencing checksum using the exact canonicalization
    // that vbundle-validator.ts uses. Any drift here would silently reject
    // valid bundles produced by buildVBundle.
    const computed = computeManifestChecksum(manifestRaw);
    if (computed !== manifest.checksum) {
      throw new StreamingValidationError(
        "manifest_sha256",
        `Manifest checksum mismatch: expected ${manifest.checksum}, computed ${computed}`,
      );
    }
  } else {
    const legacyParse = LegacyManifestSchema.safeParse(manifestRaw);
    if (!legacyParse.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new StreamingValidationError(
        "manifest_schema",
        `manifest.json failed schema validation: ${issues}`,
      );
    }
    const legacy = legacyParse.data;
    // Verify the legacy checksum using the OLD canonicalization (strip the
    // field entirely; do NOT replace with "").
    const computedLegacy = computeLegacyManifestSha256(manifestRaw);
    if (computedLegacy !== legacy.manifest_sha256) {
      throw new StreamingValidationError(
        "manifest_sha256",
        `Manifest checksum mismatch: expected ${legacy.manifest_sha256}, computed ${computedLegacy}`,
      );
    }
    manifest = translateLegacyManifest(legacy);
  }

  const expected = new Map<
    string,
    { sha256: string; size: number; linkTarget: string | null }
  >();
  for (const file of manifest.contents) {
    if (expected.has(file.path)) {
      throw new StreamingValidationError(
        "manifest_duplicate_path",
        `Manifest contains duplicate entry for path: ${file.path}`,
      );
    }
    expected.set(file.path, {
      sha256: file.sha256,
      size: file.size_bytes,
      linkTarget: file.link_target ?? null,
    });
  }

  return { manifest, expected };
}

// ---------------------------------------------------------------------------
// Symlink entry verifier
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of UTF-8 bytes / Uint8Array — local mirror of the helper in vbundle-streaming-importer.ts. */
function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify a streaming tar entry whose manifest declared it as a symlink.
 *
 * Throws `StreamingValidationError` with stable codes for each failure mode:
 *   - `entry_size`: tar header declared a non-zero size (symlink bodies must be empty).
 *   - `symlink_not_declared`: manifest entry didn't carry a `link_target` so the
 *     tar typeflag-2 record is unauthorized.
 *   - `link_target_mismatch`: tar header `linkname` doesn't equal the manifest's
 *     declared `link_target`. Either the bundle was tampered with or the producer
 *     and writer disagreed.
 *   - `entry_hash`: manifest's declared sha256 does not match the sha256 of the
 *     declared link target string. Catches manifest tampering where the attacker
 *     adjusted `link_target` but forgot to recompute the digest.
 *   - `symlink_target_escapes_archive`: the resolved link target points outside
 *     the archive root (e.g. `../../etc/passwd`). Importer would otherwise
 *     follow the symlink to a privileged path on the host.
 *
 * On success, drains the entry body via `entry.body.resume()` so the tar
 * extractor's `next` callback fires and the parser can advance to the next
 * entry — symlink bodies are size=0, but `tar-stream` still emits a Readable
 * that needs to be consumed.
 */
export function verifySymlinkEntry(input: {
  entry: StreamedTarEntry;
  expectedEntry: { sha256: string; size: number; linkTarget: string | null };
}): void {
  const { entry, expectedEntry } = input;
  const archivePath = entry.header.name;

  if (entry.header.size !== 0) {
    entry.body.resume();
    throw new StreamingValidationError(
      "entry_size",
      `Symlink entry ${archivePath} declared size ${entry.header.size}; symlink bodies must be empty`,
      archivePath,
    );
  }

  // Reject manifest-declared size_bytes != 0 for symlink entries. The buffered
  // validator catches this via FILE_SIZE_MISMATCH; without this guard a
  // crafted bundle could declare `link_target` plus `size_bytes: 100` and the
  // streaming side would accept (header.size is independent of the manifest's
  // size_bytes).
  if (expectedEntry.size !== 0) {
    entry.body.resume();
    throw new StreamingValidationError(
      "entry_size",
      `Symlink ${archivePath} has non-zero manifest-declared size ${expectedEntry.size} (expected 0)`,
      archivePath,
    );
  }

  if (expectedEntry.linkTarget == null) {
    entry.body.resume();
    throw new StreamingValidationError(
      "symlink_not_declared",
      `Tar entry ${archivePath} is a symlink but the manifest did not declare a link_target`,
      archivePath,
    );
  }

  const tarLinkname = entry.header.linkname;
  if (tarLinkname !== expectedEntry.linkTarget) {
    entry.body.resume();
    throw new StreamingValidationError(
      "link_target_mismatch",
      `Symlink target mismatch for ${archivePath}: tar header linkname=${JSON.stringify(
        tarLinkname,
      )}, manifest link_target=${JSON.stringify(expectedEntry.linkTarget)}`,
      archivePath,
    );
  }

  const computedSha = sha256Hex(expectedEntry.linkTarget);
  if (computedSha !== expectedEntry.sha256) {
    entry.body.resume();
    throw new StreamingValidationError(
      "entry_hash",
      `Symlink hash mismatch for ${archivePath}: manifest sha256=${expectedEntry.sha256}, computed over link_target=${computedSha}`,
      archivePath,
    );
  }

  // Absolute targets escape the archive root unconditionally — and would
  // bypass the resolution check below because `posix.join("workspace",
  // "/etc/passwd")` normalizes the leading `/` away and returns
  // `"workspace/etc/passwd"`. Reject these explicitly before resolution so
  // a symlink with target `/etc/passwd` cannot be imported as a real
  // host-filesystem symlink.
  if (expectedEntry.linkTarget.startsWith("/")) {
    entry.body.resume();
    throw new StreamingValidationError(
      "symlink_target_escapes_archive",
      `Symlink ${archivePath} has absolute target ${JSON.stringify(
        expectedEntry.linkTarget,
      )}, which escapes the archive root`,
      archivePath,
    );
  }

  // Path traversal: resolve the symlink target relative to the symlink's own
  // directory inside the archive. If the resolved path escapes the archive
  // root (begins with `..` or equals `..`), the target points outside the
  // bundle — refuse to import. Also reject a resolved path that is itself
  // absolute as defense-in-depth (dirname could in theory yield an absolute
  // path; cheap to guard).
  const resolved = posix.normalize(
    posix.join(posix.dirname(archivePath), expectedEntry.linkTarget),
  );
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    entry.body.resume();
    throw new StreamingValidationError(
      "symlink_target_escapes_archive",
      `Symlink ${archivePath} target ${JSON.stringify(
        expectedEntry.linkTarget,
      )} resolves to ${resolved}, which escapes the archive root`,
      archivePath,
    );
  }

  // All checks pass — drain the (empty) body so the tar extractor advances.
  entry.body.resume();
}

// ---------------------------------------------------------------------------
// Per-entry hash + size verifier
// ---------------------------------------------------------------------------

/**
 * Create a passthrough `Transform` that:
 *   - forwards every chunk unchanged (identity transform for correct input),
 *   - incrementally SHA-256s the byte stream,
 *   - on `_flush`, errors the pipeline if the final digest or total byte
 *     count differs from `expected`.
 *
 * Errors are emitted as `StreamingValidationError` with `code` set to
 * `"entry_hash"` or `"entry_size"` and `archivePath` populated so callers
 * can surface which file failed.
 *
 * Consumers should pipe the entry body through this transform before
 * writing to disk — that way a bad payload is caught before the byte
 * reaches storage rather than after a whole 8 GB write completes.
 */
export function createHashVerifier(expected: {
  sha256: string;
  size: number;
  archivePath: string;
}): Transform {
  const hash = createHash("sha256");
  let bytes = 0;

  return new Transform({
    transform(
      chunk: Buffer | string,
      encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
        hash.update(buf);
        bytes += buf.length;
        callback(null, buf);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback) {
      // Size check first — a wrong size is a sharper signal than a hash
      // collision, and a truncated payload frequently triggers both.
      if (bytes !== expected.size) {
        callback(
          new StreamingValidationError(
            "entry_size",
            `Size mismatch for ${expected.archivePath}: expected ${expected.size} bytes, got ${bytes}`,
            expected.archivePath,
          ),
        );
        return;
      }

      const digest = hash.digest("hex");
      if (digest !== expected.sha256) {
        callback(
          new StreamingValidationError(
            "entry_hash",
            `Checksum mismatch for ${expected.archivePath}: expected ${expected.sha256}, computed ${digest}`,
            expected.archivePath,
          ),
        );
        return;
      }

      callback();
    },
  });
}
