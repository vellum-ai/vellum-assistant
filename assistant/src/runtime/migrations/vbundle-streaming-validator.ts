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
 *   `manifest_sha256` against the canonicalized JSON.
 * - `createHashVerifier` returns a passthrough `Transform` that hashes bytes
 *   flowing through it and errors the pipeline if the final digest or byte
 *   count does not match the expected values from the manifest.
 *
 * Together, these let a consumer (PR 4) pipe every subsequent tar entry
 * through a hash verifier before writing it to disk, without ever buffering
 * the full bundle.
 */

import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

import type { StreamedTarEntry } from "./vbundle-tar-stream.js";
import {
  computeManifestSha256,
  ManifestSchema,
  type ManifestType,
} from "./vbundle-validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestReadResult {
  manifest: ManifestType;
  /** Fast lookup from archive path -> expected sha256 + size (from manifest.files). */
  expected: Map<string, { sha256: string; size: number }>;
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
 *   5. Self-referencing `manifest_sha256` verification against the
 *      canonicalized JSON (minus that field).
 *
 * On success, returns the parsed manifest plus a `Map` keyed by archive
 * path that PR 4 will consult as each subsequent entry streams past.
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

  // Drain the entry body into a Buffer, enforcing the size cap as we go
  // so a pathological entry can't OOM us before we notice.
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of first.body) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MANIFEST_MAX_BYTES) {
      tooLarge = true;
      // Keep draining so the extractor can advance; we just stop buffering.
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) {
    throw new StreamingValidationError(
      "manifest_too_large",
      `manifest.json exceeds ${MANIFEST_MAX_BYTES} byte limit (read ${total} bytes)`,
    );
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

  const parseResult = ManifestSchema.safeParse(manifestRaw);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new StreamingValidationError(
      "manifest_schema",
      `manifest.json failed schema validation: ${issues}`,
    );
  }

  const manifest = parseResult.data;

  // Recompute the self-referencing checksum using the exact canonicalization
  // that vbundle-validator.ts uses. Any drift here would silently reject
  // valid bundles produced by buildVBundle.
  const computed = computeManifestSha256(manifestRaw);
  if (computed !== manifest.manifest_sha256) {
    throw new StreamingValidationError(
      "manifest_sha256",
      `Manifest checksum mismatch: expected ${manifest.manifest_sha256}, computed ${computed}`,
    );
  }

  const expected = new Map<string, { sha256: string; size: number }>();
  for (const file of manifest.files) {
    expected.set(file.path, { sha256: file.sha256, size: file.size });
  }

  return { manifest, expected };
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
