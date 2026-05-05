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
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifySnapshot", () => {
  test("plaintext: returns valid:true and the manifest for a well-formed bundle", async () => {
    const { path, manifest } = writeTinyPlaintextBundle("plain.vbundle");

    const result = await verifySnapshot(path);

    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.manifest?.checksum).toBe(manifest.checksum);
    // 3 = synthetic data/db/assistant.db + workspace/notes/hello.txt + workspace/notes/about.txt
    expect(result.manifest?.contents.length).toBe(3);
  });

  test("encrypted path is rejected with a gateway redirect error", async () => {
    // Write a dummy file with .vbundle.enc extension — the content doesn't
    // matter because the rejection is based purely on file extension.
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    writeFileSync(encPath, "dummy encrypted content");

    const result = await verifySnapshot(encPath);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/gateway/i);
  });

  test("corrupt manifest: returns valid:false with the validation error", async () => {
    // Build a valid bundle, then tamper bytes in the middle
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

    const tampered = Buffer.from(archive);
    const tamperOffset = Math.floor(tampered.length / 2);
    tampered[tamperOffset] = tampered[tamperOffset] ^ 0xff;
    tampered[tamperOffset + 1] = tampered[tamperOffset + 1] ^ 0xff;

    const path = join(TEST_DIR, "corrupt.vbundle");
    writeFileSync(path, tampered);

    const result = await verifySnapshot(path);

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
    expect(passed.preValidatedManifest?.checksum).toBe(manifest.checksum);
    expect(passed.preValidatedEntries).toBeDefined();
    expect(passed.preValidatedEntries?.has("manifest.json")).toBe(true);
    expect(passed.preValidatedEntries?.has("workspace/notes/hello.txt")).toBe(
      true,
    );
    expect(passed.archiveData).toBeInstanceOf(Uint8Array);
    expect(passed.archiveData.length).toBeGreaterThan(0);

    expect(result.manifest.checksum).toBe(manifest.checksum);
    expect(result.restoredFiles).toBe(3);
  });

  test("encrypted path is rejected with a gateway redirect error", async () => {
    const encPath = join(TEST_DIR, "plain.vbundle.enc");
    writeFileSync(encPath, "dummy encrypted content");

    const { commitImpl, calls } = makeStubCommitImpl();

    await expect(
      restoreFromSnapshot(encPath, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
      }),
    ).rejects.toThrow(/gateway/i);

    expect(calls.length).toBe(0);
  });

  test("credentials in a bundle are ignored and not surfaced to the caller", async () => {
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

    expect(result.manifest.checksum).toBe(manifest.checksum);
    expect("credentials" in result).toBe(false);
  });

  test("validation failure: throws with the validation error message", async () => {
    const path = join(TEST_DIR, "garbage.vbundle");
    writeFileSync(path, Buffer.from("not a real bundle"));

    const { commitImpl, calls } = makeStubCommitImpl();

    await expect(
      restoreFromSnapshot(path, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
      }),
    ).rejects.toThrow(/Snapshot failed validation/);

    expect(calls.length).toBe(0);
  });

  test("resetDbImpl runs before commitImpl and is skipped when validation fails", async () => {
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

  test("version-incompatible bundle short-circuits before resetDbImpl and commitImpl", async () => {
    // Bundle declares it requires runtime 99.0.0+, but the test process is
    // far below that. The restore wrapper must pre-check compat before the
    // DB close/reopen cycle and skip both resetDbImpl and commitImpl.
    const incompatPath = join(TEST_DIR, "incompat.vbundle");
    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "workspace/notes/hello.txt",
          data: new TextEncoder().encode("hello"),
        },
      ],
      ...defaultV1Options(),
      compatibility: {
        min_runtime_version: "99.0.0",
        max_runtime_version: null,
      },
    });
    writeFileSync(incompatPath, archive);

    const { commitImpl, calls } = makeStubCommitImpl();
    let resetCalls = 0;

    await expect(
      restoreFromSnapshot(incompatPath, {
        pathResolver: NULL_RESOLVER,
        commitImpl,
        resetDbImpl: () => {
          resetCalls += 1;
        },
      }),
    ).rejects.toThrow(/Snapshot restore failed.*99\.0\.0/);

    expect(resetCalls).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe("snapshot path detection", () => {
  test("plaintext path that doesn't exist surfaces an I/O error from verify", async () => {
    const path = join(TEST_DIR, "missing.vbundle");
    expect(existsSync(path)).toBe(false);

    const result = await verifySnapshot(path);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
