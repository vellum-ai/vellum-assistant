/**
 * Tests for restoreFromSnapshot and verifySnapshot.
 *
 * The destructive bits of restore (commitImport — overwrites files,
 * clears the workspace, runs per-file backup-before-overwrite) are stubbed
 * via the `commitImpl` injection parameter so these tests never touch the
 * live workspace.
 *
 * Note: `commitImport` itself does NOT reset the SQLite singleton or
 * invalidate caches — those are the caller's responsibility. The HTTP and
 * CLI restore handlers wrap this module with the appropriate `resetDb()` /
 * `invalidateConfigCache()` / `clearTrustCache()` calls; the tests for that
 * recovery sequence live in `backup-routes.test.ts` and `backup.test.ts`.
 *
 * Credentials are intentionally excluded from backups, so `restoreFromSnapshot`
 * has no credential-related surface area — bundles that happen to include
 * `credentials/*` entries (e.g. from older migration exports) are ignored
 * here and never surfaced to the caller.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultV1Options } from "../../runtime/migrations/__tests__/v1-test-helpers.js";
import { buildVBundle } from "../../runtime/migrations/vbundle-builder.js";
import type { PathResolver } from "../../runtime/migrations/vbundle-import-analyzer.js";
import type {
  ImportCommitOptions,
  ImportCommitResult,
} from "../../runtime/migrations/vbundle-importer.js";
import type { ManifestType } from "../../runtime/migrations/vbundle-validator.js";
import { restoreFromSnapshot, verifySnapshot } from "../restore.js";
import { ENCRYPTED_HEADER_SIZE, encryptFile } from "../stream-crypt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = join(
    tmpdir(),
    `vellum-restore-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * A null PathResolver — the stubbed commitImpl never calls it, so we just
 * need a value of the right shape for the type-checker.
 */
const NULL_RESOLVER: PathResolver = {
  resolve() {
    return null;
  },
};

/**
 * Build a tiny in-memory plaintext .vbundle and write it to a path. Returns
 * the file path along with the manifest the builder embedded so tests can
 * compare against it.
 */
function writeTinyPlaintextBundle(fileName: string): {
  path: string;
  manifest: ManifestType;
} {
  const { archive, manifest } = buildVBundle({
    files: [
      { path: "data/db/assistant.db", data: new Uint8Array() },
      {
        path: "workspace/notes/hello.txt",
        data: new TextEncoder().encode("hello world"),
      },
      {
        path: "workspace/notes/about.txt",
        data: new TextEncoder().encode("a tiny bundle for tests"),
      },
    ],
    ...defaultV1Options(),
  });

  const path = join(TEST_DIR, fileName);
  writeFileSync(path, archive);
  return { path, manifest };
}

/**
 * Capture the arguments passed to commitImport without performing any
 * destructive work. Records the call and returns a synthetic success
 * report so the caller can introspect what the wrapper passed in.
 */
interface RecordedCall {
  options: ImportCommitOptions;
}

function makeStubCommitImpl(): {
  commitImpl: (options: ImportCommitOptions) => ImportCommitResult;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const commitImpl = (options: ImportCommitOptions): ImportCommitResult => {
    calls.push({ options });
    const manifest: ManifestType =
      options.preValidatedManifest ??
      ({
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: new Date().toISOString(),
        assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
        origin: { mode: "self-hosted-local" },
        compatibility: {
          min_runtime_version: "0.0.0-test",
          max_runtime_version: null,
        },
        contents: [],
        checksum:
          "0000000000000000000000000000000000000000000000000000000000000000",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      } as ManifestType);
    return {
      ok: true,
      report: {
        success: true,
        summary: {
          total_files: manifest.contents.length,
          files_created: manifest.contents.length,
          files_overwritten: 0,
          files_skipped: 0,
          backups_created: 0,
        },
        files: [],
        manifest,
        warnings: [],
      },
    };
  };
  return { commitImpl, calls };
}

/** Throwing stub used to verify temp-file cleanup on commit failure. */
function makeThrowingCommitImpl(): (
  options: ImportCommitOptions,
) => ImportCommitResult {
  return () => {
    throw new Error("simulated commit failure");
  };
}

/**
 * Snapshot the OS temp directory so tests can later verify that nothing
 * matching `vellum-restore-*.vbundle` was left behind. Restricting the
 * search to that prefix avoids racing with unrelated processes.
 */
function listRestoreTempArtifacts(): string[] {
  return readdirSync(tmpdir()).filter((name) =>
    name.startsWith("vellum-restore-"),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifySnapshot", () => {
  test("plaintext: returns valid:true and the manifest for a well-formed bundle", async () => {
    const { path, manifest } = writeTinyPlaintextBundle("plain.vbundle");

    const result = await verifySnapshot(path, {});

    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.manifest?.checksum).toBe(manifest.checksum);
    // 3 = synthetic data/db/assistant.db + workspace/notes/hello.txt + workspace/notes/about.txt
    expect(result.manifest?.contents.length).toBe(3);
  });

  test("encrypted: returns valid:true after decrypting first", async () => {
    const { path: plainPath } = writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    const before = listRestoreTempArtifacts();
    const result = await verifySnapshot(encPath, { key });
    const after = listRestoreTempArtifacts();

    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    // The decrypted temp file must be cleaned up after verification.
    expect(after.length).toBe(before.length);
  });

  test("encrypted with no key throws the typed error", async () => {
    const { path: plainPath } = writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    await expect(verifySnapshot(encPath, {})).rejects.toThrow(
      "Encrypted snapshot requires a decryption key",
    );
  });

  test("corrupt ciphertext: returns valid:false with the decrypt error", async () => {
    const { path: plainPath } = writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    // Flip a byte inside the ciphertext body — auth tag verification fails.
    const flipOffset = ENCRYPTED_HEADER_SIZE + 4;
    const fh = await open(encPath, "r+");
    try {
      const one = Buffer.alloc(1);
      await fh.read(one, 0, 1, flipOffset);
      one[0] = one[0] ^ 0xff;
      await fh.write(one, 0, 1, flipOffset);
    } finally {
      await fh.close();
    }

    const before = listRestoreTempArtifacts();
    const result = await verifySnapshot(encPath, { key });
    const after = listRestoreTempArtifacts();

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.manifest).toBeUndefined();
    // Even on failure, the decrypted temp file must be cleaned up.
    expect(after.length).toBe(before.length);
  });

  test("corrupt manifest: returns valid:false with the validation error", async () => {
    // Build a valid bundle, then re-encrypt with the manifest tampered.
    // We tamper at the plaintext bundle level so encryption succeeds but
    // validateVBundle catches the bad manifest.
    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
      ],
      ...defaultV1Options(),
    });

    // Flip a few bytes in the middle of the gzipped archive — this almost
    // always corrupts the gzip stream itself or the embedded manifest JSON,
    // both of which are validation failures (NOT decryption failures).
    const tampered = Buffer.from(archive);
    const tamperOffset = Math.floor(tampered.length / 2);
    tampered[tamperOffset] = tampered[tamperOffset] ^ 0xff;
    tampered[tamperOffset + 1] = tampered[tamperOffset + 1] ^ 0xff;

    const path = join(TEST_DIR, "corrupt.vbundle");
    writeFileSync(path, tampered);

    const result = await verifySnapshot(path, {});

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.manifest).toBeUndefined();
  });
});

describe("restoreFromSnapshot", () => {
  test("plaintext round-trip: passes the validated bundle through to commitImpl", async () => {
    const { path, manifest } = writeTinyPlaintextBundle("plain.vbundle");
    const { commitImpl, calls } = makeStubCommitImpl();
    let resetDbCalls = 0;

    const result = await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      commitImpl,
      resetDbImpl: () => {
        resetDbCalls += 1;
      },
    });

    // resetDbImpl must run exactly once before the commit step, so the
    // live SQLite singleton is closed before assistant.db is overwritten.
    expect(resetDbCalls).toBe(1);

    expect(calls.length).toBe(1);
    const passed = calls[0].options;
    // The wrapper should pass the pre-validated manifest + entries so
    // commitImport doesn't re-validate.
    expect(passed.preValidatedManifest?.checksum).toBe(manifest.checksum);
    expect(passed.preValidatedEntries).toBeDefined();
    expect(passed.preValidatedEntries?.has("manifest.json")).toBe(true);
    expect(passed.preValidatedEntries?.has("workspace/notes/hello.txt")).toBe(
      true,
    );
    // archiveData must be the actual bundle bytes.
    expect(passed.archiveData).toBeInstanceOf(Uint8Array);
    expect(passed.archiveData.length).toBeGreaterThan(0);

    // Public result is shaped correctly.
    expect(result.manifest.checksum).toBe(manifest.checksum);
    expect(result.restoredFiles).toBe(3);
  });

  test("encrypted round-trip: decrypts then commits, and cleans up the temp file", async () => {
    const { path: plainPath, manifest } =
      writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    const { commitImpl, calls } = makeStubCommitImpl();

    const before = listRestoreTempArtifacts();
    const result = await restoreFromSnapshot(encPath, {
      key,
      pathResolver: NULL_RESOLVER,
      commitImpl,
    });
    const after = listRestoreTempArtifacts();

    expect(calls.length).toBe(1);
    expect(result.manifest.checksum).toBe(manifest.checksum);
    expect(result.restoredFiles).toBe(3);

    // Decrypted temp file must be cleaned up after the call.
    expect(after.length).toBe(before.length);
  });

  test("encrypted with no key throws the typed error", async () => {
    const { path: plainPath } = writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    const { commitImpl, calls } = makeStubCommitImpl();

    await expect(
      restoreFromSnapshot(encPath, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
      }),
    ).rejects.toThrow("Encrypted snapshot requires a decryption key");

    expect(calls.length).toBe(0);
  });

  test("temp decrypted file is cleaned up after a commit failure", async () => {
    const { path: plainPath } = writeTinyPlaintextBundle("plain.vbundle");
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    const key = randomBytes(32);
    await encryptFile(plainPath, encPath, key);

    const before = listRestoreTempArtifacts();
    await expect(
      restoreFromSnapshot(encPath, {
        key,
        pathResolver: NULL_RESOLVER,
        commitImpl: makeThrowingCommitImpl(),
      }),
    ).rejects.toThrow("simulated commit failure");
    const after = listRestoreTempArtifacts();

    expect(after.length).toBe(before.length);
  });

  test("credentials in a bundle are ignored and not surfaced to the caller", async () => {
    // Older bundles (or a shared vbundle format) may include `credentials/*`
    // entries. Backup restore explicitly drops them — credentials live in
    // the OS keychain / CES and are not part of the backup round trip.
    const { archive, manifest } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
        {
          path: "credentials/openai_api_key",
          data: new TextEncoder().encode("sk-test-1234"),
        },
      ],
      ...defaultV1Options(),
    });

    const path = join(TEST_DIR, "with-creds.vbundle");
    writeFileSync(path, archive);

    const { commitImpl } = makeStubCommitImpl();
    const result = await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      commitImpl,
    });

    // The restore result must not expose a `credentials` field — the public
    // type only has `manifest` and `restoredFiles`.
    expect(result.manifest.checksum).toBe(manifest.checksum);
    expect("credentials" in result).toBe(false);
  });

  test("validation failure: throws with the validation error message", async () => {
    // Write garbage to a .vbundle path — gzip decompression will fail.
    const path = join(TEST_DIR, "garbage.vbundle");
    writeFileSync(path, Buffer.from("not a real bundle"));

    const { commitImpl, calls } = makeStubCommitImpl();

    await expect(
      restoreFromSnapshot(path, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
      }),
    ).rejects.toThrow(/Snapshot failed validation/);

    // commitImpl must NOT have been called when validation fails.
    expect(calls.length).toBe(0);
  });

  test("resetDbImpl runs before commitImpl and is skipped when validation fails", async () => {
    // Happy path: resetDb must be called, and must be called BEFORE the
    // commit step so the SQLite handle is released before assistant.db is
    // overwritten on disk.
    const { path } = writeTinyPlaintextBundle("plain.vbundle");
    const order: string[] = [];
    const { commitImpl } = makeStubCommitImpl();
    const instrumentedCommit = (opts: ImportCommitOptions) => {
      order.push("commit");
      return commitImpl(opts);
    };

    await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      commitImpl: instrumentedCommit,
      resetDbImpl: () => {
        order.push("reset");
      },
    });

    expect(order).toEqual(["reset", "commit"]);

    // Failure path: when validation fails, resetDb must NOT be invoked —
    // there's no reason to close the DB singleton if we're not going to
    // overwrite anything on disk.
    const garbagePath = join(TEST_DIR, "garbage-for-reset.vbundle");
    writeFileSync(garbagePath, Buffer.from("not a real bundle"));
    let resetCallsOnInvalid = 0;

    await expect(
      restoreFromSnapshot(garbagePath, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
        resetDbImpl: () => {
          resetCallsOnInvalid += 1;
        },
      }),
    ).rejects.toThrow(/Snapshot failed validation/);

    expect(resetCallsOnInvalid).toBe(0);
  });

  test("commit returning a write_failed result is surfaced as an error", async () => {
    const { path } = writeTinyPlaintextBundle("plain.vbundle");

    // Stub that simulates a write failure (the importer returns this for
    // disk errors like permission denied or partial bundle writes).
    const failingCommit = (_opts: ImportCommitOptions): ImportCommitResult => ({
      ok: false,
      reason: "write_failed",
      message: "disk full",
    });

    await expect(
      restoreFromSnapshot(path, {
        pathResolver: NULL_RESOLVER,
        commitImpl: failingCommit,
      }),
    ).rejects.toThrow(/disk full/);
  });
});

describe("snapshot path detection", () => {
  test("plaintext path that doesn't exist surfaces an I/O error from verify", async () => {
    const path = join(TEST_DIR, "missing.vbundle");
    expect(existsSync(path)).toBe(false);

    const result = await verifySnapshot(path, {});

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
