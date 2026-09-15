/**
 * Pinned backup pools.
 *
 * `POST /v1/backups/create` with `{ pin: <label> }` copies the fresh snapshot
 * into `<backup root>/pinned/<label>/`. The worker's retention prunes the
 * shared local pool, which every bare-metal assistant on a machine writes
 * to, so a caller that needs a snapshot to outlive that pool (a pre-teleport
 * restore point) asks for a pinned copy instead.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let backupRoot: string;
let localDir: string;
let exportCalls = 0;

beforeEach(async () => {
  backupRoot = await mkdtemp(join(tmpdir(), "backup-pin-"));
  localDir = join(backupRoot, "local");
  process.env.VELLUM_BACKUP_DIR = backupRoot;
  exportCalls = 0;

  mock.module("../config-file-utils.js", () => ({
    readConfigFileOrEmpty: () => ({
      backup: {
        enabled: true,
        intervalHours: 6,
        retention: 1,
        offsite: { enabled: false },
        localDirectory: localDir,
      },
    }),
  }));

  mock.module("../auth/token-exchange.js", () => ({
    mintServiceToken: () => "test-service-token",
  }));

  mock.module("../fetch.js", () => ({
    fetchImpl: async () => {
      exportCalls += 1;
      return new Response(new Uint8Array([0x50, 0x4b, exportCalls]), {
        status: 200,
      });
    },
  }));
});

afterEach(async () => {
  mock.restore();
  delete process.env.VELLUM_BACKUP_DIR;
  await rm(backupRoot, { recursive: true, force: true });
});

const deps = { assistantRuntimeBaseUrl: "http://127.0.0.1:7821" };

/**
 * Snapshot filenames carry a millisecond timestamp and retention sorts by
 * it, so two snapshots cut in the same millisecond tie. Space consecutive
 * runs out so "newest" is well defined.
 */
const nextMillisecond = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

describe("pinned backup pools", () => {
  test("a pin label copies the snapshot into its own pool", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    const result = await createSnapshotNow(deps, { pin: "ast-1" });

    expect(result.pinned).not.toBeNull();
    expect(result.pinned?.filename).toBe(result.local.filename);
    expect(result.pinned?.path).toBe(
      join(backupRoot, "pinned", "ast-1", result.local.filename),
    );
    expect(await readdir(join(backupRoot, "pinned", "ast-1"))).toEqual([
      result.local.filename,
    ]);
  });

  test("no pin label leaves the pinned root untouched", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    const result = await createSnapshotNow(deps);

    expect(result.pinned).toBeNull();
    await expect(readdir(join(backupRoot, "pinned"))).rejects.toThrow();
  });

  test("local-pool retention does not touch pinned copies", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    const first = await createSnapshotNow(deps, { pin: "ast-1" });
    await nextMillisecond();
    // A later snapshot from any gateway sharing the local pool (retention 1
    // prunes the earlier local file).
    const second = await createSnapshotNow(deps);

    expect(await readdir(localDir)).toEqual([second.local.filename]);
    expect(await readdir(join(backupRoot, "pinned", "ast-1"))).toEqual([
      first.local.filename,
    ]);
  });

  test("each pinned pool keeps its own three newest snapshots", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");
    const pinnedDir = join(backupRoot, "pinned", "ast-1");
    // Pre-existing pinned snapshots older than anything the worker writes.
    await mkdir(pinnedDir, { recursive: true });
    for (const stamp of ["20200101-000000-000", "20200102-000000-000"]) {
      await writeFile(join(pinnedDir, `backup-${stamp}.vbundle`), "x");
    }
    await createSnapshotNow(deps, { pin: "ast-1" });
    await nextMillisecond();
    const second = await createSnapshotNow(deps, { pin: "ast-1" });

    const kept = await readdir(pinnedDir);
    expect(kept).toHaveLength(3);
    expect(kept).toContain(second.local.filename);
    expect(kept).not.toContain("backup-20200101-000000-000.vbundle");
  });
});

describe("POST /v1/backups/create pin body", () => {
  test("rejects an unsafe pin label before exporting", async () => {
    const { createBackupSnapshotHandler } =
      await import("../backup/backup-routes.js");
    const handler = createBackupSnapshotHandler(deps);

    const response = await handler(
      new Request("http://gateway/v1/backups/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "../escape" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(exportCalls).toBe(0);
  });

  test("returns the pinned copy alongside the local snapshot", async () => {
    const { createBackupSnapshotHandler } =
      await import("../backup/backup-routes.js");
    const handler = createBackupSnapshotHandler(deps);

    const response = await handler(
      new Request("http://gateway/v1/backups/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "ast-1" }),
      }),
    );
    const body = (await response.json()) as {
      success: boolean;
      pinned: { path: string } | null;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pinned?.path).toContain(join("pinned", "ast-1"));
  });

  test("an empty body still takes an unpinned snapshot", async () => {
    const { createBackupSnapshotHandler } =
      await import("../backup/backup-routes.js");
    const handler = createBackupSnapshotHandler(deps);

    const response = await handler(
      new Request("http://gateway/v1/backups/create", { method: "POST" }),
    );
    const body = (await response.json()) as { pinned: unknown };

    expect(response.status).toBe(200);
    expect(body.pinned).toBeNull();
  });

  test("GET /v1/backups lists pinned pools", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");
    const { createListBackupsHandler } =
      await import("../backup/backup-routes.js");
    const pinned = await createSnapshotNow(deps, { pin: "ast-1" });

    const response = await createListBackupsHandler(deps)(
      new Request("http://gateway/v1/backups"),
    );
    const body = (await response.json()) as {
      pinned: Array<{ label: string; snapshots: Array<{ path: string }> }>;
    };

    expect(pinned.pinned).not.toBeNull();
    expect(body.pinned).toHaveLength(1);
    expect(body.pinned[0].label).toBe("ast-1");
    expect(body.pinned[0].snapshots.map((s) => s.path)).toEqual([
      pinned.pinned?.path ?? "",
    ]);
  });
});
