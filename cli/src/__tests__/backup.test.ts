import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Lockfile isolation (mirrors teleport.test.ts)
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-backup-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks set up before importing the module under test
// ---------------------------------------------------------------------------

import * as fs from "node:fs";

import * as assistantConfig from "../lib/assistant-config.js";
import * as backupOps from "../lib/backup-ops.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as localRuntimeClient from "../lib/local-runtime-client.js";
import { MigrationInProgressError } from "../lib/local-runtime-client.js";
import * as platformClient from "../lib/platform-client.js";

const findAssistantByNameMock = spyOn(
  assistantConfig,
  "findAssistantByName",
).mockReturnValue(null);

const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue("platform-token");

const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("https://platform.vellum.ai");

const platformRequestSignedUrlMock = spyOn(
  platformClient,
  "platformRequestSignedUrl",
).mockImplementation(async (params) => ({
  url:
    params.operation === "upload"
      ? "https://storage.googleapis.com/bucket/signed-upload"
      : "https://storage.googleapis.com/bucket/signed-download",
  bundleKey: params.bundleKey ?? "uploads/org-1/bundle-abc.vbundle",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
}));

const localRuntimeExportToGcsMock = spyOn(
  localRuntimeClient,
  "localRuntimeExportToGcs",
).mockResolvedValue({ jobId: "platform-export-job-1" });

const localRuntimePollJobStatusMock = spyOn(
  localRuntimeClient,
  "localRuntimePollJobStatus",
).mockResolvedValue({
  jobId: "platform-export-job-1",
  type: "export",
  status: "complete",
  result: { manifest_sha256: "abc123def456" },
});

// Mode 1 (runtime-direct local backup) uses guardian tokens. Don't exercise
// it here, but the spies need to exist so the module under test can import
// them without surprises.
spyOn(guardianToken, "loadGuardianToken").mockReturnValue({
  accessToken: "local-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
} as unknown as ReturnType<typeof guardianToken.loadGuardianToken>);
spyOn(guardianToken, "leaseGuardianToken").mockResolvedValue({
  accessToken: "leased-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
} as unknown as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>);

const getBackupsDirMock = spyOn(backupOps, "getBackupsDir").mockReturnValue(
  "/tmp/backups-default",
);

const mkdirSyncMock = spyOn(fs, "mkdirSync").mockImplementation(
  (() => undefined) as never,
);
const writeFileSyncMock = spyOn(fs, "writeFileSync").mockImplementation(
  () => undefined,
);

let originalFetch: typeof globalThis.fetch;
let exitMock: ReturnType<typeof mock>;

const VELLUM_ENTRY = {
  assistantId: "11111111-2222-3333-4444-555555555555",
  runtimeUrl: "https://platform.vellum.ai",
  cloud: "vellum",
  species: "vellum",
  hatchedAt: new Date().toISOString(),
} satisfies assistantConfig.AssistantEntry;

function setArgv(...rest: string[]) {
  process.argv = ["bun", "vellum", "backup", ...rest];
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  exitMock = mock((code?: number) => {
    throw new Error(`process.exit:${code}`);
  });
  process.exit = exitMock as unknown as typeof process.exit;

  findAssistantByNameMock.mockReset();
  findAssistantByNameMock.mockReturnValue(null);
  readPlatformTokenMock.mockReset();
  readPlatformTokenMock.mockReturnValue("platform-token");
  getPlatformUrlMock.mockReset();
  getPlatformUrlMock.mockReturnValue("https://platform.vellum.ai");
  platformRequestSignedUrlMock.mockReset();
  platformRequestSignedUrlMock.mockImplementation(async (params) => ({
    url:
      params.operation === "upload"
        ? "https://storage.googleapis.com/bucket/signed-upload"
        : "https://storage.googleapis.com/bucket/signed-download",
    bundleKey: params.bundleKey ?? "uploads/org-1/bundle-abc.vbundle",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }));
  localRuntimeExportToGcsMock.mockReset();
  localRuntimeExportToGcsMock.mockResolvedValue({
    jobId: "platform-export-job-1",
  });
  localRuntimePollJobStatusMock.mockReset();
  localRuntimePollJobStatusMock.mockResolvedValue({
    jobId: "platform-export-job-1",
    type: "export",
    status: "complete",
    result: { manifest_sha256: "abc123def456" },
  });
  getBackupsDirMock.mockReset();
  getBackupsDirMock.mockReturnValue("/tmp/backups-default");
  mkdirSyncMock.mockReset();
  mkdirSyncMock.mockImplementation((() => undefined) as never);
  writeFileSyncMock.mockReset();
  writeFileSyncMock.mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  // Restore module-level spies so they don't bleed into other test files
  // when bun test runs the whole suite.
  findAssistantByNameMock.mockRestore();
  readPlatformTokenMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  platformRequestSignedUrlMock.mockRestore();
  localRuntimeExportToGcsMock.mockRestore();
  localRuntimePollJobStatusMock.mockRestore();
  getBackupsDirMock.mockRestore();
  mkdirSyncMock.mockRestore();
  writeFileSyncMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

import { backup } from "../commands/backup.js";

// ---------------------------------------------------------------------------
// Helper: simulated GCS download response
// ---------------------------------------------------------------------------
function mockGcsDownload(body: Uint8Array, ok = true, status = 200) {
  globalThis.fetch = mock(async () => {
    const responseBody: BodyInit = ok
      ? new Blob([body as unknown as ArrayBuffer])
      : "boom";
    return new Response(responseBody, {
      status,
      statusText: ok ? "OK" : "Error",
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("vellum backup <platform-managed>: GCS happy path", () => {
  test("requests upload URL → kicks off runtime export → polls → downloads from GCS → writes file", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    setArgv("my-platform");

    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockGcsDownload(bytes);

    await backup();

    // Upload-URL request to the platform.
    expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "upload" }),
      "platform-token",
      "https://platform.vellum.ai",
    );

    // Runtime export-to-gcs kicked off via the entry-aware helper. URL
    // construction is exercised in `local-runtime-client.test.ts`; here we
    // assert the helper got the right entry + token + params.
    expect(localRuntimeExportToGcsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: "vellum",
        runtimeUrl: "https://platform.vellum.ai",
        assistantId: "11111111-2222-3333-4444-555555555555",
      }),
      "platform-token",
      expect.objectContaining({
        uploadUrl: "https://storage.googleapis.com/bucket/signed-upload",
        description: "CLI backup",
      }),
    );

    // Poll uses the entry-aware helper (wildcard URL, NOT the dedicated
    // platform jobs/{id}/ endpoint).
    expect(localRuntimePollJobStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ cloud: "vellum" }),
      "platform-token",
      "platform-export-job-1",
    );

    // Download URL keyed off the upload's bundleKey.
    expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
      {
        operation: "download",
        bundleKey: "uploads/org-1/bundle-abc.vbundle",
      },
      "platform-token",
      "https://platform.vellum.ai",
    );

    // GCS fetch went directly to the signed download URL with no auth.
    const gcsFetch = globalThis.fetch as unknown as ReturnType<typeof mock>;
    expect(gcsFetch).toHaveBeenCalledWith(
      "https://storage.googleapis.com/bucket/signed-download",
    );

    // File written to disk with the bytes from GCS.
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [outputPath, written] = writeFileSyncMock.mock.calls[0]!;
    expect(written).toEqual(bytes);
    expect(typeof outputPath).toBe("string");
    expect(outputPath as string).toMatch(
      /\/tmp\/backups-default\/my-platform-.*\.vbundle$/,
    );
    expect(mkdirSyncMock).toHaveBeenCalled();
  });

  test("--output override is respected", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    setArgv("my-platform", "--output", "/custom/path/backup.vbundle");

    mockGcsDownload(new Uint8Array([7, 7, 7]));

    await backup();

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    expect(writeFileSyncMock.mock.calls[0]![0]).toBe(
      "/custom/path/backup.vbundle",
    );
  });

  test("default output path is getBackupsDir() + name-timestamp.vbundle", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    setArgv("my-platform");

    mockGcsDownload(new Uint8Array([1]));

    await backup();

    const [outputPath] = writeFileSyncMock.mock.calls[0]!;
    expect(outputPath as string).toMatch(
      /^\/tmp\/backups-default\/my-platform-/,
    );
    expect(outputPath as string).toMatch(/\.vbundle$/);
  });
});

describe("vellum backup <platform-managed>: failure cases", () => {
  test("not logged in (no platform token) exits with 'Run vellum login'", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    readPlatformTokenMock.mockReturnValue(null);
    setArgv("my-platform");

    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    try {
      await expect(backup()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Not logged in"),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("MigrationInProgressError on kickoff exits with 'Another backup or teleport export'", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    localRuntimeExportToGcsMock.mockRejectedValue(
      new MigrationInProgressError("export_in_progress", "existing-job-99"),
    );
    setArgv("my-platform");

    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    try {
      await expect(backup()).rejects.toThrow("process.exit:1");
      const calls = consoleErrorSpy.mock.calls.map((c) => c[0]);
      expect(
        calls.some(
          (m) =>
            typeof m === "string" &&
            m.includes("Another backup or teleport export") &&
            m.includes("existing-job-99"),
        ),
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("terminal=failed exits with 'Export failed: <reason>'", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    localRuntimePollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "failed",
      error: "vbundle build crashed",
    });
    setArgv("my-platform");

    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    try {
      await expect(backup()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Export failed: vbundle build crashed"),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("GCS fetch !ok exits with 'Failed to fetch bundle from GCS (<status>)'", async () => {
    findAssistantByNameMock.mockReturnValue(VELLUM_ENTRY);
    setArgv("my-platform");

    mockGcsDownload(new Uint8Array(), false, 403);

    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    try {
      await expect(backup()).rejects.toThrow("process.exit:1");
      const calls = consoleErrorSpy.mock.calls.map((c) => c[0]);
      expect(
        calls.some(
          (m) =>
            typeof m === "string" &&
            m.includes("Failed to fetch bundle from GCS") &&
            m.includes("403"),
        ),
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
