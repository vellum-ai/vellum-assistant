/**
 * Tests for restoreFromSnapshot and verifySnapshot.
 *
 * The destructive bits of restore (commitImport — overwrites files,
 * resets the DB, etc.) are stubbed via the `commitImpl` injection
 * parameter so these tests never touch the live workspace.
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
function writeTinyPlaintextBundle(
  fileName: string,
): { path: string; manifest: ManifestType } {
  const { archive, manifest } = buildVBundle({
    files: [
      {
        path: "workspace/notes/hello.txt",
        data: new TextEncoder().encode("hello world"),
      },
      {
        path: "workspace/notes/about.txt",
        data: new TextEncoder().encode("a tiny bundle for tests"),
      },
    ],
    source: "restore-test",
    description: "tiny bundle for restore.test.ts",
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
    const manifest =
      options.preValidatedManifest ??
      ({
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [],
        manifest_sha256: "stub",
      } satisfies ManifestType);
    return {
      ok: true,
      report: {
        success: true,
        summary: {
          total_files: manifest.files.length,
          files_created: manifest.files.length,
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
    expect(result.manifest?.manifest_sha256).toBe(manifest.manifest_sha256);
    expect(result.manifest?.files.length).toBe(2);
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
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
      ],
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

    const result = await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      commitImpl,
    });

    expect(calls.length).toBe(1);
    const passed = calls[0].options;
    // The wrapper should pass the pre-validated manifest + entries so
    // commitImport doesn't re-validate.
    expect(passed.preValidatedManifest?.manifest_sha256).toBe(
      manifest.manifest_sha256,
    );
    expect(passed.preValidatedEntries).toBeDefined();
    expect(passed.preValidatedEntries?.has("manifest.json")).toBe(true);
    expect(
      passed.preValidatedEntries?.has("workspace/notes/hello.txt"),
    ).toBe(true);
    // archiveData must be the actual bundle bytes.
    expect(passed.archiveData).toBeInstanceOf(Uint8Array);
    expect(passed.archiveData.length).toBeGreaterThan(0);

    // Public result is shaped correctly.
    expect(result.manifest.manifest_sha256).toBe(manifest.manifest_sha256);
    expect(result.restoredFiles).toBe(2);
    expect(result.credentials).toEqual([]);
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
    expect(result.manifest.manifest_sha256).toBe(manifest.manifest_sha256);
    expect(result.restoredFiles).toBe(2);

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

  test("includeCredentials: surfaces credential entries to the caller", async () => {
    const { archive, manifest } = buildVBundle({
      files: [
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
        {
          path: "credentials/openai_api_key",
          data: new TextEncoder().encode("sk-test-1234"),
        },
        {
          path: "credentials/anthropic_api_key",
          data: new TextEncoder().encode("sk-ant-test-5678"),
        },
      ],
    });

    const path = join(TEST_DIR, "with-creds.vbundle");
    writeFileSync(path, archive);

    const { commitImpl } = makeStubCommitImpl();
    const result = await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      includeCredentials: true,
      commitImpl,
    });

    expect(result.manifest.manifest_sha256).toBe(manifest.manifest_sha256);
    // Credentials are extracted via extractCredentialsFromBundle, which
    // returns one entry per credentials/* file. Order is not guaranteed,
    // so we sort before comparing.
    const sorted = [...result.credentials].sort((a, b) =>
      a.account.localeCompare(b.account),
    );
    expect(sorted).toEqual([
      { account: "anthropic_api_key", value: "sk-ant-test-5678" },
      { account: "openai_api_key", value: "sk-test-1234" },
    ]);
  });

  test("includeCredentials defaults to false", async () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
        {
          path: "credentials/secret_key",
          data: new TextEncoder().encode("super-secret"),
        },
      ],
    });

    const path = join(TEST_DIR, "with-creds.vbundle");
    writeFileSync(path, archive);

    const { commitImpl } = makeStubCommitImpl();
    const result = await restoreFromSnapshot(path, {
      pathResolver: NULL_RESOLVER,
      commitImpl,
    });

    expect(result.credentials).toEqual([]);
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

  test("commit returning a write_failed result is surfaced as an error", async () => {
    const { path } = writeTinyPlaintextBundle("plain.vbundle");

    // Stub that simulates a write failure (the importer returns this for
    // disk errors like permission denied or partial bundle writes).
    const failingCommit = (
      _opts: ImportCommitOptions,
    ): ImportCommitResult => ({
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
