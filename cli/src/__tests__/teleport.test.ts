import {
  afterAll,
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
// Temp directory for lockfile isolation (same pattern as assistant-config.test.ts)
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-teleport-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Import the real assistant-config module — do NOT mock it with mock.module()
// because Bun's mock.module() replaces the module globally and leaks into
// other test files (e.g. multi-local.test.ts) running in the same process.
// Instead, we use spyOn to mock findAssistantByName on the imported module object.
import * as assistantConfig from "../lib/assistant-config.js";

const findAssistantByNameMock = spyOn(
  assistantConfig,
  "findAssistantByName",
).mockReturnValue(null);

const loadGuardianTokenMock = mock((_id: string) => ({
  accessToken: "local-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
}));
const leaseGuardianTokenMock = mock(async () => ({
  accessToken: "leased-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
}));

mock.module("../lib/guardian-token.js", () => ({
  loadGuardianToken: loadGuardianTokenMock,
  leaseGuardianToken: leaseGuardianTokenMock,
}));

const readPlatformTokenMock = mock((): string | null => "platform-token");
const fetchOrganizationIdMock = mock(async () => "org-123");
const platformInitiateExportMock = mock(async () => ({
  jobId: "job-1",
  status: "pending",
}));
const platformPollExportStatusMock = mock(async () => ({
  status: "complete" as string,
  downloadUrl: "https://cdn.example.com/bundle.tar.gz",
}));
const platformDownloadExportMock = mock(async () => {
  const data = new Uint8Array([10, 20, 30]);
  return new Response(data, { status: 200 });
});
const platformImportPreflightMock = mock(async () => ({
  statusCode: 200,
  body: {
    can_import: true,
    summary: {
      files_to_create: 2,
      files_to_overwrite: 1,
      files_unchanged: 0,
      total_files: 3,
    },
  } as Record<string, unknown>,
}));
const platformImportBundleMock = mock(async () => ({
  statusCode: 200,
  body: {
    success: true,
    summary: {
      total_files: 3,
      files_created: 2,
      files_overwritten: 1,
      files_skipped: 0,
      backups_created: 1,
    },
  } as Record<string, unknown>,
}));

mock.module("../lib/platform-client.js", () => ({
  readPlatformToken: readPlatformTokenMock,
  fetchOrganizationId: fetchOrganizationIdMock,
  platformInitiateExport: platformInitiateExportMock,
  platformPollExportStatus: platformPollExportStatusMock,
  platformDownloadExport: platformDownloadExportMock,
  platformImportPreflight: platformImportPreflightMock,
  platformImportBundle: platformImportBundleMock,
}));

import { teleport } from "../commands/teleport.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  findAssistantByNameMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
});

let originalArgv: string[];
let exitMock: ReturnType<typeof mock>;
let originalExit: typeof process.exit;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  originalArgv = [...process.argv];

  // Reset all mocks
  findAssistantByNameMock.mockReset();
  findAssistantByNameMock.mockReturnValue(null);

  loadGuardianTokenMock.mockReset();
  loadGuardianTokenMock.mockReturnValue({
    accessToken: "local-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  leaseGuardianTokenMock.mockReset();

  readPlatformTokenMock.mockReset();
  readPlatformTokenMock.mockReturnValue("platform-token");
  fetchOrganizationIdMock.mockReset();
  fetchOrganizationIdMock.mockResolvedValue("org-123");
  platformInitiateExportMock.mockReset();
  platformInitiateExportMock.mockResolvedValue({
    jobId: "job-1",
    status: "pending",
  });
  platformPollExportStatusMock.mockReset();
  platformPollExportStatusMock.mockResolvedValue({
    status: "complete",
    downloadUrl: "https://cdn.example.com/bundle.tar.gz",
  });
  platformDownloadExportMock.mockReset();
  platformDownloadExportMock.mockResolvedValue(
    new Response(new Uint8Array([10, 20, 30]), { status: 200 }),
  );
  platformImportPreflightMock.mockReset();
  platformImportPreflightMock.mockResolvedValue({
    statusCode: 200,
    body: {
      can_import: true,
      summary: {
        files_to_create: 2,
        files_to_overwrite: 1,
        files_unchanged: 0,
        total_files: 3,
      },
    },
  });
  platformImportBundleMock.mockReset();
  platformImportBundleMock.mockResolvedValue({
    statusCode: 200,
    body: {
      success: true,
      summary: {
        total_files: 3,
        files_created: 2,
        files_overwritten: 1,
        files_skipped: 0,
        backups_created: 1,
      },
    },
  });

  // Mock process.exit to throw so we can catch it
  exitMock = mock((code?: number) => {
    throw new Error(`process.exit:${code}`);
  });
  originalExit = process.exit;
  process.exit = exitMock as unknown as typeof process.exit;

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
});

import { afterEach } from "bun:test";

afterEach(() => {
  process.argv = originalArgv;
  process.exit = originalExit;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

function setArgv(...args: string[]): void {
  // teleport reads process.argv.slice(3)
  process.argv = ["bun", "vellum", "teleport", ...args];
}

function makeEntry(
  id: string,
  overrides?: Partial<AssistantEntry>,
): AssistantEntry {
  return {
    assistantId: id,
    runtimeUrl: "http://localhost:7821",
    cloud: "local",
    ...overrides,
  };
}

/** Extract the URL string from a fetch mock call argument. */
function extractUrl(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "url" in arg) {
    return (arg as { url: string }).url;
  }
  return String(arg);
}

/** Filter fetch mock calls by URL substring. */
function filterFetchCalls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchMock: { mock: { calls: any[][] } },
  substring: string,
): unknown[][] {
  return fetchMock.mock.calls.filter((call: unknown[]) =>
    extractUrl(call[0]).includes(substring),
  );
}

// ---------------------------------------------------------------------------
// Arg parsing tests
// ---------------------------------------------------------------------------

describe("teleport arg parsing", () => {
  test("--help prints usage and exits 0", async () => {
    setArgv("--help");
    await expect(teleport()).rejects.toThrow("process.exit:0");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("-h prints usage and exits 0", async () => {
    setArgv("-h");
    await expect(teleport()).rejects.toThrow("process.exit:0");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("missing --from and --to prints help and exits 1", async () => {
    setArgv();
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("missing --to prints help and exits 1", async () => {
    setArgv("--from", "source");
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("missing --from prints help and exits 1", async () => {
    setArgv("--to", "target");
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("--from and --to are correctly parsed", async () => {
    setArgv("--from", "source", "--to", "target");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "source") return makeEntry("source");
      if (name === "target") return makeEntry("target");
      return null;
    });

    // This will attempt a fetch to the local export endpoint, which will fail.
    // We just want to confirm parsing worked (i.e. it gets past the arg check).
    // Mock global fetch to avoid network calls.
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/export")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      // import endpoint — return valid JSON
      return new Response(
        JSON.stringify({
          success: true,
          summary: {
            total_files: 1,
            files_created: 1,
            files_overwritten: 0,
            files_skipped: 0,
            backups_created: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Should call findAssistantByName for both source and target
      expect(findAssistantByNameMock).toHaveBeenCalledWith("source");
      expect(findAssistantByNameMock).toHaveBeenCalledWith("target");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--dry-run flag is detected", async () => {
    setArgv("--from", "source", "--to", "target", "--dry-run");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "source") return makeEntry("source");
      if (name === "target") return makeEntry("target");
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/export")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (urlStr.includes("/import-preflight")) {
        return new Response(
          JSON.stringify({
            can_import: true,
            summary: {
              files_to_create: 1,
              files_to_overwrite: 0,
              files_unchanged: 0,
              total_files: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // In dry-run mode for local target, it should call the preflight endpoint
      const preflightCalls = filterFetchCalls(fetchMock, "import-preflight");
      expect(preflightCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unknown assistant name causes exit with error", async () => {
    setArgv("--from", "nonexistent", "--to", "target");
    findAssistantByNameMock.mockReturnValue(null);

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found in lockfile"),
    );
  });
});

// ---------------------------------------------------------------------------
// Cloud resolution tests
// ---------------------------------------------------------------------------

describe("teleport cloud resolution", () => {
  test("entry with cloud: 'vellum' resolves to vellum", async () => {
    setArgv("--from", "src", "--to", "dst");

    const srcEntry = makeEntry("src", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const dstEntry = makeEntry("dst", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    // Platform export path: readPlatformToken → fetchOrganizationId → initiateExport → poll → download
    // then local import
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          summary: {
            total_files: 1,
            files_created: 1,
            files_overwritten: 0,
            files_skipped: 0,
            backups_created: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Should have used platform export functions
      expect(platformInitiateExportMock).toHaveBeenCalled();
      expect(platformPollExportStatusMock).toHaveBeenCalled();
      expect(platformDownloadExportMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("entry with cloud: 'local' resolves to local", async () => {
    setArgv("--from", "src", "--to", "dst");

    const srcEntry = makeEntry("src", { cloud: "local" });
    const dstEntry = makeEntry("dst", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Local export uses fetch to /v1/migrations/export
      const exportCalls = filterFetchCalls(fetchMock, "/v1/migrations/export");
      expect(exportCalls.length).toBe(1);
      // Platform import should be called
      expect(platformImportBundleMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("entry with no cloud but project set resolves to gcp (unsupported)", async () => {
    setArgv("--from", "src", "--to", "dst");

    // cloud is empty string or undefined — resolveCloud checks entry.project
    const srcEntry = makeEntry("src", {
      cloud: "" as string,
      project: "my-gcp-project",
    });
    const dstEntry = makeEntry("dst", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    // GCP is unsupported, should print error and exit
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("only supports local and platform"),
    );
  });

  test("entry with no cloud and no project resolves to local", async () => {
    setArgv("--from", "src", "--to", "dst");

    // cloud is falsy, no project — resolveCloud returns "local"
    const srcEntry = makeEntry("src", { cloud: "" as string });
    const dstEntry = makeEntry("dst", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/export")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      // import endpoint
      return new Response(
        JSON.stringify({
          success: true,
          summary: {
            total_files: 1,
            files_created: 1,
            files_overwritten: 0,
            files_skipped: 0,
            backups_created: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Should use local export (fetch to /v1/migrations/export)
      const exportCalls = filterFetchCalls(fetchMock, "/v1/migrations/export");
      expect(exportCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Transfer routing tests
// ---------------------------------------------------------------------------

describe("teleport transfer routing", () => {
  test("local → platform calls local export endpoint and platform import", async () => {
    setArgv("--from", "local-src", "--to", "platform-dst");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "local-src")
        return makeEntry("local-src", { cloud: "local" });
      if (name === "platform-dst")
        return makeEntry("platform-dst", {
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
        });
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Local export: should call fetch to /v1/migrations/export
      const exportCalls = filterFetchCalls(fetchMock, "/v1/migrations/export");
      expect(exportCalls.length).toBe(1);

      // Platform import: should call platformImportBundle
      expect(platformImportBundleMock).toHaveBeenCalled();

      // Should NOT call platform export functions
      expect(platformInitiateExportMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("platform → local calls platform export functions and local import endpoint", async () => {
    setArgv("--from", "platform-src", "--to", "local-dst");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "platform-src")
        return makeEntry("platform-src", {
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
        });
      if (name === "local-dst")
        return makeEntry("local-dst", { cloud: "local" });
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          summary: {
            total_files: 3,
            files_created: 2,
            files_overwritten: 1,
            files_skipped: 0,
            backups_created: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Platform export: should call all three platform export functions
      expect(platformInitiateExportMock).toHaveBeenCalled();
      expect(platformPollExportStatusMock).toHaveBeenCalled();
      expect(platformDownloadExportMock).toHaveBeenCalled();

      // Local import: should call fetch to /v1/migrations/import (but not /import-preflight)
      const importCalls = filterFetchCalls(
        fetchMock,
        "/v1/migrations/import",
      ).filter((call) => !extractUrl(call[0]).includes("/import-preflight"));
      expect(importCalls.length).toBe(1);

      // Should NOT call platformImportBundle
      expect(platformImportBundleMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--dry-run calls preflight instead of import (local target)", async () => {
    setArgv("--from", "src", "--to", "dst", "--dry-run");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return makeEntry("src", { cloud: "local" });
      if (name === "dst") return makeEntry("dst", { cloud: "local" });
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/export")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (urlStr.includes("/import-preflight")) {
        return new Response(
          JSON.stringify({
            can_import: true,
            summary: {
              files_to_create: 1,
              files_to_overwrite: 0,
              files_unchanged: 0,
              total_files: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Should call preflight endpoint
      const preflightCalls = filterFetchCalls(fetchMock, "import-preflight");
      expect(preflightCalls.length).toBe(1);

      // Should NOT call the actual import endpoint
      const importCalls = filterFetchCalls(fetchMock, "/import").filter(
        (call) => !extractUrl(call[0]).includes("preflight"),
      );
      expect(importCalls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--dry-run calls platformImportPreflight instead of platformImportBundle (platform target)", async () => {
    setArgv("--from", "src", "--to", "dst", "--dry-run");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return makeEntry("src", { cloud: "local" });
      if (name === "dst")
        return makeEntry("dst", {
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
        });
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Should call platformImportPreflight
      expect(platformImportPreflightMock).toHaveBeenCalled();

      // Should NOT call platformImportBundle
      expect(platformImportBundleMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("platform → platform calls platform export and platform import", async () => {
    setArgv("--from", "platform-src", "--to", "platform-dst");

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "platform-src")
        return makeEntry("platform-src", {
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
        });
      if (name === "platform-dst")
        return makeEntry("platform-dst", {
          cloud: "vellum",
          runtimeUrl: "https://platform2.vellum.ai",
        });
      return null;
    });

    await teleport();

    // Platform export: should call all three platform export functions
    expect(platformInitiateExportMock).toHaveBeenCalled();
    expect(platformPollExportStatusMock).toHaveBeenCalled();
    expect(platformDownloadExportMock).toHaveBeenCalled();

    // Platform import: should call platformImportBundle
    expect(platformImportBundleMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge case: extra/unrecognized arguments
// ---------------------------------------------------------------------------

describe("teleport extra arguments", () => {
  test("extra unrecognized flags are ignored and command works normally", async () => {
    setArgv(
      "--from",
      "src",
      "--to",
      "dst",
      "--bogus-flag",
      "--another-unknown",
    );

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return makeEntry("src", { cloud: "local" });
      if (name === "dst") return makeEntry("dst", { cloud: "local" });
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/export")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          summary: {
            total_files: 1,
            files_created: 1,
            files_overwritten: 0,
            files_skipped: 0,
            backups_created: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Should have proceeded normally despite extra flags
      expect(findAssistantByNameMock).toHaveBeenCalledWith("src");
      expect(findAssistantByNameMock).toHaveBeenCalledWith("dst");
      const exportCalls = filterFetchCalls(fetchMock, "/v1/migrations/export");
      expect(exportCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case: --from or --to without a following value
// ---------------------------------------------------------------------------

describe("teleport malformed flag usage", () => {
  test("--from as the last argument (no value) prints help and exits 1", async () => {
    setArgv("--to", "target", "--from");
    // --from is the last arg so parseArgs won't assign a value to `from`
    // This should result in missing --from and trigger help + exit 1
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("--to as the last argument (no value) prints help and exits 1", async () => {
    setArgv("--from", "source", "--to");
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("--from --to target consumes --to as from's value, leaving to undefined", async () => {
    setArgv("--from", "--to", "target");
    // parseArgs sees --from then consumes "--to" as from's value.
    // "target" is left as a positional arg. to remains undefined → prints help and exits 1.
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });
});
