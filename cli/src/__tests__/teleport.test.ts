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

const saveAssistantEntryMock = spyOn(
  assistantConfig,
  "saveAssistantEntry",
).mockImplementation(() => {});

const loadAllAssistantsMock = spyOn(
  assistantConfig,
  "loadAllAssistants",
).mockReturnValue([]);

const removeAssistantEntryMock = spyOn(
  assistantConfig,
  "removeAssistantEntry",
).mockImplementation(() => {});

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
const getPlatformUrlMock = mock(() => "https://platform.vellum.ai");
const hatchAssistantMock = mock(async () => ({
  id: "platform-new-id",
  name: "platform-new",
  status: "active",
}));
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
  getPlatformUrl: getPlatformUrlMock,
  hatchAssistant: hatchAssistantMock,
  platformInitiateExport: platformInitiateExportMock,
  platformPollExportStatus: platformPollExportStatusMock,
  platformDownloadExport: platformDownloadExportMock,
  platformImportPreflight: platformImportPreflightMock,
  platformImportBundle: platformImportBundleMock,
}));

const hatchLocalMock = mock(async () => {});

mock.module("../lib/hatch-local.js", () => ({
  hatchLocal: hatchLocalMock,
}));

const hatchDockerMock = mock(async () => {});
const retireDockerMock = mock(async () => {});

const sleepContainersMock = mock(async () => {});
const dockerResourceNamesMock = mock((name: string) => ({
  assistantContainer: `${name}-assistant`,
  gatewayContainer: `${name}-gateway`,
  cesContainer: `${name}-ces`,
  network: `${name}-net`,
}));

mock.module("../lib/docker.js", () => ({
  hatchDocker: hatchDockerMock,
  retireDocker: retireDockerMock,
  sleepContainers: sleepContainersMock,
  dockerResourceNames: dockerResourceNamesMock,
}));

const stopProcessByPidFileMock = mock(async () => true);

mock.module("../lib/process.js", () => ({
  stopProcessByPidFile: stopProcessByPidFileMock,
}));

const retireLocalMock = mock(async () => {});

mock.module("../lib/retire-local.js", () => ({
  retireLocal: retireLocalMock,
}));

import {
  teleport,
  parseArgs,
  resolveOrHatchTarget,
} from "../commands/teleport.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  findAssistantByNameMock.mockRestore();
  saveAssistantEntryMock.mockRestore();
  loadAllAssistantsMock.mockRestore();
  removeAssistantEntryMock.mockRestore();
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
  saveAssistantEntryMock.mockReset();
  saveAssistantEntryMock.mockImplementation(() => {});
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([]);
  removeAssistantEntryMock.mockReset();
  removeAssistantEntryMock.mockImplementation(() => {});

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
  getPlatformUrlMock.mockReset();
  getPlatformUrlMock.mockReturnValue("https://platform.vellum.ai");
  hatchAssistantMock.mockReset();
  hatchAssistantMock.mockResolvedValue({
    id: "platform-new-id",
    name: "platform-new",
    status: "active",
  });
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

  hatchLocalMock.mockReset();
  hatchLocalMock.mockResolvedValue(undefined);
  hatchDockerMock.mockReset();
  hatchDockerMock.mockResolvedValue(undefined);
  retireDockerMock.mockReset();
  retireDockerMock.mockResolvedValue(undefined);
  retireLocalMock.mockReset();
  retireLocalMock.mockResolvedValue(undefined);
  sleepContainersMock.mockReset();
  sleepContainersMock.mockResolvedValue(undefined);
  stopProcessByPidFileMock.mockReset();
  stopProcessByPidFileMock.mockResolvedValue(true);

  // Mock process.exit to throw so we can catch it
  exitMock = mock((code?: number) => {
    throw new Error(`process.exit:${code}`);
  });
  originalExit = process.exit;
  process.exit = exitMock as unknown as typeof process.exit;

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
});

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

/** Create a mock fetch that handles export and import endpoints. */
function createFetchMock() {
  return mock(async (url: string | URL | Request) => {
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
    if (urlStr.includes("/import")) {
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
    }
    return new Response("not found", { status: 404 });
  });
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

  test("missing --from and env flag prints help and exits 1", async () => {
    setArgv();
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("missing env flag prints help and exits 1", async () => {
    setArgv("--from", "source");
    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:"),
    );
  });

  test("--local sets targetEnv to 'local' with no name", () => {
    const result = parseArgs(["--from", "source", "--local"]);
    expect(result.from).toBe("source");
    expect(result.targetEnv).toBe("local");
    expect(result.targetName).toBeUndefined();
  });

  test("--docker my-name sets targetEnv to 'docker' and targetName to 'my-name'", () => {
    const result = parseArgs(["--from", "source", "--docker", "my-name"]);
    expect(result.from).toBe("source");
    expect(result.targetEnv).toBe("docker");
    expect(result.targetName).toBe("my-name");
  });

  test("--platform sets targetEnv to 'platform'", () => {
    const result = parseArgs(["--from", "source", "--platform"]);
    expect(result.from).toBe("source");
    expect(result.targetEnv).toBe("platform");
    expect(result.targetName).toBeUndefined();
  });

  test("multiple env flags error", () => {
    expect(() => parseArgs(["--from", "src", "--local", "--docker"])).toThrow(
      "process.exit:1",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Only one environment flag"),
    );
  });

  test("--keep-source is parsed", () => {
    const result = parseArgs(["--from", "source", "--docker", "--keep-source"]);
    expect(result.keepSource).toBe(true);
  });

  test("--dry-run is parsed", () => {
    const result = parseArgs(["--from", "source", "--local", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  test("target name after env flag is consumed but --flags are not", () => {
    const result = parseArgs(["--from", "source", "--docker", "--keep-source"]);
    expect(result.targetEnv).toBe("docker");
    expect(result.targetName).toBeUndefined();
    expect(result.keepSource).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Same-environment rejection tests
// ---------------------------------------------------------------------------

describe("same-environment rejection", () => {
  test("source local, target local -> error (after resolving target)", async () => {
    setArgv("--from", "src", "--local", "dst");

    const srcEntry = makeEntry("src", { cloud: "local" });
    const dstEntry = makeEntry("dst", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cannot teleport between two local assistants"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("source docker, target docker -> error (after resolving target)", async () => {
    setArgv("--from", "src", "--docker", "dst");

    const srcEntry = makeEntry("src", { cloud: "docker" });
    const dstEntry = makeEntry("dst", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot teleport between two docker assistants",
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("source vellum, target platform -> error (after resolving target)", async () => {
    setArgv("--from", "src", "--platform", "dst");

    const srcEntry = makeEntry("src", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
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
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot teleport between two platform assistants",
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("same-env rejection happens before hatching (no orphaned assistants)", async () => {
    setArgv("--from", "my-local", "--local");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot teleport between two local assistants"),
    );
    // Crucially: no hatch should have been called — the early guard fires first
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("same-env rejection before hatching for docker", async () => {
    setArgv("--from", "my-docker", "--docker");

    const dockerEntry = makeEntry("my-docker", { cloud: "docker" });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-docker") return dockerEntry;
      return null;
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot teleport between two docker assistants"),
    );
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("same-env rejection before hatching for platform (vellum cloud)", async () => {
    setArgv("--from", "my-cloud", "--platform");

    const platformEntry = makeEntry("my-cloud", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-cloud") return platformEntry;
      return null;
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cannot teleport between two platform assistants",
      ),
    );
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("flag says docker but resolved target is local -> rejects cloud mismatch", async () => {
    // User passes --docker but the named target is actually a local assistant
    setArgv("--from", "src", "--docker", "misidentified");

    const srcEntry = makeEntry("src", { cloud: "vellum" });
    // Target is actually local despite the --docker flag
    const dstEntry = makeEntry("misidentified", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "misidentified") return dstEntry;
      return null;
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("is a local assistant, not docker"),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveOrHatchTarget tests
// ---------------------------------------------------------------------------

describe("resolveOrHatchTarget", () => {
  test("existing assistant is returned without hatching", async () => {
    const dockerEntry = makeEntry("my-docker", { cloud: "docker" });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-docker") return dockerEntry;
      return null;
    });

    const result = await resolveOrHatchTarget("docker", "my-docker");
    expect(result).toBe(dockerEntry);
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Target: my-docker (docker)"),
    );
  });

  test("name not found -> hatch docker", async () => {
    const newEntry = makeEntry("new-one", { cloud: "docker" });
    findAssistantByNameMock.mockImplementation((name: string) => {
      // First call: lookup by name -> not found
      // Second call: after hatch -> found
      if (name === "new-one" && hatchDockerMock.mock.calls.length > 0) {
        return newEntry;
      }
      return null;
    });

    const result = await resolveOrHatchTarget("docker", "new-one");
    expect(hatchDockerMock).toHaveBeenCalledWith(
      "vellum",
      false,
      "new-one",
      false,
      {},
    );
    expect(result).toBe(newEntry);
  });

  test("no name -> hatch local with null name, discovers via diff", async () => {
    const existingEntry = makeEntry("existing-local", { cloud: "local" });
    const newEntry = makeEntry("auto-generated", { cloud: "local" });

    // Before hatch: only the existing entry
    // After hatch: existing + new entry
    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchLocalMock.mock.calls.length > 0) {
        return [existingEntry, newEntry];
      }
      return [existingEntry];
    });

    const result = await resolveOrHatchTarget("local");
    expect(hatchLocalMock).toHaveBeenCalledWith(
      "vellum",
      null,
      false,
      false,
      false,
      {},
    );
    expect(result).toBe(newEntry);
  });

  test("platform with existing ID -> returns existing without hatching", async () => {
    const platformEntry = makeEntry("uuid-123", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "uuid-123") return platformEntry;
      return null;
    });

    const result = await resolveOrHatchTarget("platform", "uuid-123");
    expect(result).toBe(platformEntry);
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("platform with unknown name -> hatches via hatchAssistant", async () => {
    findAssistantByNameMock.mockReturnValue(null);

    const result = await resolveOrHatchTarget("platform", "nonexistent");
    expect(hatchAssistantMock).toHaveBeenCalledWith("platform-token");
    expect(saveAssistantEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "platform-new-id",
        cloud: "vellum",
      }),
    );
    expect(result.assistantId).toBe("platform-new-id");
  });

  test("existing assistant with wrong cloud -> rejects", async () => {
    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    await expect(resolveOrHatchTarget("docker", "my-local")).rejects.toThrow(
      "process.exit:1",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("is a local assistant, not docker"),
    );
  });

  test("name with path traversal -> rejects before hatching", async () => {
    findAssistantByNameMock.mockReturnValue(null);

    await expect(
      resolveOrHatchTarget("docker", "../../../etc/passwd"),
    ).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid characters"),
    );
    expect(hatchDockerMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-retire tests
// ---------------------------------------------------------------------------

describe("auto-retire", () => {
  test("local -> docker: stops source before hatch, retires after import", async () => {
    setArgv("--from", "my-local", "--docker");

    const localEntry = makeEntry("my-local", {
      cloud: "local",
      resources: {
        instanceDir: "/home/test",
        pidFile: "/home/test/.vellum/assistant.pid",
        signingKey: "key",
        daemonPort: 7821,
        gatewayPort: 7830,
        qdrantPort: 6333,
        cesPort: 8090,
      },
    });
    const dockerEntry = makeEntry("new-docker", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    // Simulate hatch creating a new docker entry
    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchDockerMock.mock.calls.length > 0) {
        return [localEntry, dockerEntry];
      }
      return [localEntry];
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Source should be stopped (slept) before hatch
      expect(stopProcessByPidFileMock).toHaveBeenCalled();
      // Retire happens after successful import
      expect(retireLocalMock).toHaveBeenCalledWith("my-local", localEntry);
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("my-local");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("docker -> local: sleeps containers before hatch, retires after import", async () => {
    setArgv("--from", "my-docker", "--local");

    const dockerEntry = makeEntry("my-docker", { cloud: "docker" });
    const localEntry = makeEntry("new-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-docker") return dockerEntry;
      return null;
    });

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchLocalMock.mock.calls.length > 0) {
        return [dockerEntry, localEntry];
      }
      return [dockerEntry];
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      // Docker source should be slept (containers stopped) before hatch
      expect(sleepContainersMock).toHaveBeenCalled();
      // Retire happens after successful import
      expect(retireDockerMock).toHaveBeenCalledWith("my-docker");
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("my-docker");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--keep-source skips retire and removeAssistantEntry", async () => {
    setArgv("--from", "my-local", "--docker", "--keep-source");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("new-docker", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchDockerMock.mock.calls.length > 0) {
        return [localEntry, dockerEntry];
      }
      return [localEntry];
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      expect(retireLocalMock).not.toHaveBeenCalled();
      expect(retireDockerMock).not.toHaveBeenCalled();
      expect(removeAssistantEntryMock).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("kept (--keep-source)"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("platform transfers skip retire", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await teleport();
      expect(retireLocalMock).not.toHaveBeenCalled();
      expect(retireDockerMock).not.toHaveBeenCalled();
      expect(removeAssistantEntryMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("dry-run without existing target does not hatch or export", async () => {
    setArgv("--from", "my-local", "--docker", "--dry-run");

    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    await teleport();

    // Should NOT hatch, export, import, or retire
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(retireDockerMock).not.toHaveBeenCalled();
    expect(removeAssistantEntryMock).not.toHaveBeenCalled();
  });

  test("dry-run with existing target runs preflight without hatching", async () => {
    setArgv("--from", "my-local", "--docker", "my-docker", "--dry-run");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("my-docker", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      if (name === "my-docker") return dockerEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock() as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Should NOT hatch or retire
      expect(hatchDockerMock).not.toHaveBeenCalled();
      expect(hatchLocalMock).not.toHaveBeenCalled();
      expect(retireLocalMock).not.toHaveBeenCalled();
      expect(retireDockerMock).not.toHaveBeenCalled();
      expect(removeAssistantEntryMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Full flow tests
// ---------------------------------------------------------------------------

describe("teleport full flow", () => {
  test("hatch and import: --from my-local --docker", async () => {
    setArgv("--from", "my-local", "--docker");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("new-docker", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      return null;
    });

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchDockerMock.mock.calls.length > 0) {
        return [localEntry, dockerEntry];
      }
      return [localEntry];
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = createFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // Verify sequence: export, hatch, import, retire
      expect(hatchDockerMock).toHaveBeenCalled();
      expect(retireLocalMock).toHaveBeenCalledWith("my-local", localEntry);
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("my-local");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Teleport complete"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("existing target overwrite: --from my-local --docker my-existing", async () => {
    setArgv("--from", "my-local", "--docker", "my-existing");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("my-existing", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      if (name === "my-existing") return dockerEntry;
      return null;
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = createFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      await teleport();

      // No hatch should happen — existing target is used
      expect(hatchDockerMock).not.toHaveBeenCalled();
      // Source should still be retired
      expect(retireLocalMock).toHaveBeenCalledWith("my-local", localEntry);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Teleport complete"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("legacy --to flag shows deprecation message", async () => {
    setArgv("--from", "source", "--to", "target");

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--to is deprecated"),
    );
  });
});
