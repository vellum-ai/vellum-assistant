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
// Temp directory for lockfile isolation
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-teleport-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as platformClient from "../lib/platform-client.js";
import * as localRuntimeClient from "../lib/local-runtime-client.js";

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

const loadGuardianTokenMock = spyOn(
  guardianToken,
  "loadGuardianToken",
).mockReturnValue({
  accessToken: "local-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
} as unknown as ReturnType<typeof guardianToken.loadGuardianToken>);

const leaseGuardianTokenMock = spyOn(
  guardianToken,
  "leaseGuardianToken",
).mockResolvedValue({
  accessToken: "leased-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
} as unknown as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>);

const computeDeviceIdMock = spyOn(
  guardianToken,
  "computeDeviceId",
).mockReturnValue("device-id-123");

const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue("platform-token");

const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("https://platform.vellum.ai");

const hatchAssistantMock = spyOn(
  platformClient,
  "hatchAssistant",
).mockResolvedValue({
  assistant: {
    id: "platform-new-id",
    name: "platform-new",
    status: "active",
  },
  reusedExisting: false,
});

const platformPollJobStatusMock = spyOn(
  platformClient,
  "platformPollJobStatus",
).mockResolvedValue({
  jobId: "platform-job-1",
  type: "export",
  status: "complete",
  bundleKey: "platform-bundle-key-abc",
});

const platformRequestSignedUrlMock = spyOn(
  platformClient,
  "platformRequestSignedUrl",
).mockImplementation(async (params) => ({
  url:
    params.operation === "upload"
      ? "https://storage.googleapis.com/bucket/signed-upload"
      : "https://storage.googleapis.com/bucket/signed-download",
  bundleKey: params.bundleKey ?? "bundle-key-123",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
}));

const platformImportBundleFromGcsMock = spyOn(
  platformClient,
  "platformImportBundleFromGcs",
).mockResolvedValue({
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
});

const platformImportPreflightFromGcsMock = spyOn(
  platformClient,
  "platformImportPreflightFromGcs",
).mockResolvedValue({
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
});

const checkExistingPlatformAssistantMock = spyOn(
  platformClient,
  "checkExistingPlatformAssistant",
).mockResolvedValue(null);

const ensureSelfHostedLocalRegistrationMock = spyOn(
  platformClient,
  "ensureSelfHostedLocalRegistration",
).mockResolvedValue({
  assistant: { id: "platform-assistant-1", name: "my-assistant" },
  registration: {
    client_installation_id: "device-id-123",
    runtime_assistant_id: "target-local",
    client_platform: "cli",
  },
  assistant_api_key: "api-key-123",
  webhook_secret: "webhook-secret-123",
} as unknown as Awaited<
  ReturnType<typeof platformClient.ensureSelfHostedLocalRegistration>
>);

const injectCredentialsIntoAssistantMock = spyOn(
  platformClient,
  "injectCredentialsIntoAssistant",
).mockResolvedValue(true);

const fetchCurrentUserMock = spyOn(
  platformClient,
  "fetchCurrentUser",
).mockResolvedValue({
  id: "user-1",
  email: "test@example.com",
  display: "Test",
} as unknown as Awaited<ReturnType<typeof platformClient.fetchCurrentUser>>);

const fetchOrganizationIdMock = spyOn(
  platformClient,
  "fetchOrganizationId",
).mockResolvedValue("org-1");

const localRuntimeExportToGcsMock = spyOn(
  localRuntimeClient,
  "localRuntimeExportToGcs",
).mockResolvedValue({ jobId: "local-export-job-1" });

const localRuntimeImportFromGcsMock = spyOn(
  localRuntimeClient,
  "localRuntimeImportFromGcs",
).mockResolvedValue({ jobId: "local-import-job-1" });

const localRuntimePollJobStatusMock = spyOn(
  localRuntimeClient,
  "localRuntimePollJobStatus",
).mockImplementation(async (_runtimeUrl, _token, jobId) => ({
  jobId,
  type: jobId.includes("import") ? "import" : "export",
  status: "complete",
  result: {
    success: true,
    summary: {
      total_files: 3,
      files_created: 2,
      files_overwritten: 1,
      files_skipped: 0,
      backups_created: 1,
    },
  },
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
  cesContainer: `${name}-credential-executor`,
  cesSecurityVolume: `${name}-ces-sec`,
  dockerdDataVolume: `${name}-dockerd-data`,
  gatewayContainer: `${name}-gateway`,
  gatewaySecurityVolume: `${name}-gateway-sec`,
  network: `${name}-net`,
  socketVolume: `${name}-socket`,
  workspaceVolume: `${name}-workspace`,
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

const fetchCurrentVersionMock = mock(
  async (_runtimeUrl: string): Promise<string | undefined> => undefined,
);

mock.module("../lib/upgrade-lifecycle.js", () => ({
  fetchCurrentVersion: fetchCurrentVersionMock,
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
  loadGuardianTokenMock.mockRestore();
  leaseGuardianTokenMock.mockRestore();
  readPlatformTokenMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  hatchAssistantMock.mockRestore();
  checkExistingPlatformAssistantMock.mockRestore();
  platformPollJobStatusMock.mockRestore();
  platformRequestSignedUrlMock.mockRestore();
  platformImportBundleFromGcsMock.mockRestore();
  platformImportPreflightFromGcsMock.mockRestore();
  ensureSelfHostedLocalRegistrationMock.mockRestore();
  injectCredentialsIntoAssistantMock.mockRestore();
  fetchCurrentUserMock.mockRestore();
  fetchOrganizationIdMock.mockRestore();
  computeDeviceIdMock.mockRestore();
  localRuntimeExportToGcsMock.mockRestore();
  localRuntimeImportFromGcsMock.mockRestore();
  localRuntimePollJobStatusMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
});

let originalArgv: string[];
let exitMock: ReturnType<typeof mock>;
let originalExit: typeof process.exit;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let fetchCalls: Array<{ url: string; body: unknown }>;

function defaultLocalRuntimePollImpl(
  _entry: unknown,
  _token: string,
  jobId: string,
): Promise<{
  jobId: string;
  type: "export" | "import";
  status: "complete";
  result: Record<string, unknown>;
}> {
  return Promise.resolve({
    jobId,
    type: jobId.includes("import") ? "import" : "export",
    status: "complete",
    result: {
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
}

beforeEach(() => {
  originalArgv = [...process.argv];
  fetchCalls = [];

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
  } as unknown as ReturnType<typeof guardianToken.loadGuardianToken>);
  leaseGuardianTokenMock.mockReset();

  readPlatformTokenMock.mockReset();
  readPlatformTokenMock.mockReturnValue("platform-token");
  getPlatformUrlMock.mockReset();
  getPlatformUrlMock.mockReturnValue("https://platform.vellum.ai");
  hatchAssistantMock.mockReset();
  hatchAssistantMock.mockResolvedValue({
    assistant: {
      id: "platform-new-id",
      name: "platform-new",
      status: "active",
    },
    reusedExisting: false,
  });
  platformPollJobStatusMock.mockReset();
  platformPollJobStatusMock.mockResolvedValue({
    jobId: "platform-job-1",
    type: "export",
    status: "complete",
    bundleKey: "platform-bundle-key-abc",
  });
  platformRequestSignedUrlMock.mockReset();
  platformRequestSignedUrlMock.mockImplementation(async (params) => ({
    url:
      params.operation === "upload"
        ? "https://storage.googleapis.com/bucket/signed-upload"
        : "https://storage.googleapis.com/bucket/signed-download",
    bundleKey: params.bundleKey ?? "bundle-key-123",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }));
  platformImportBundleFromGcsMock.mockReset();
  platformImportBundleFromGcsMock.mockResolvedValue({
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
  platformImportPreflightFromGcsMock.mockReset();
  platformImportPreflightFromGcsMock.mockResolvedValue({
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
  checkExistingPlatformAssistantMock.mockReset();
  checkExistingPlatformAssistantMock.mockResolvedValue(null);
  ensureSelfHostedLocalRegistrationMock.mockReset();
  ensureSelfHostedLocalRegistrationMock.mockResolvedValue({
    assistant: { id: "platform-assistant-1", name: "my-assistant" },
    registration: {
      client_installation_id: "device-id-123",
      runtime_assistant_id: "target-local",
      client_platform: "cli",
    },
    assistant_api_key: "api-key-123",
    webhook_secret: "webhook-secret-123",
  });
  injectCredentialsIntoAssistantMock.mockReset();
  injectCredentialsIntoAssistantMock.mockResolvedValue(true);
  fetchCurrentUserMock.mockReset();
  fetchCurrentUserMock.mockResolvedValue({
    id: "user-1",
    email: "test@example.com",
    display: "Test",
  });
  fetchOrganizationIdMock.mockReset();
  fetchOrganizationIdMock.mockResolvedValue("org-1");
  computeDeviceIdMock.mockReset();
  computeDeviceIdMock.mockReturnValue("device-id-123");

  localRuntimeExportToGcsMock.mockReset();
  localRuntimeExportToGcsMock.mockResolvedValue({
    jobId: "local-export-job-1",
  });
  localRuntimeImportFromGcsMock.mockReset();
  localRuntimeImportFromGcsMock.mockResolvedValue({
    jobId: "local-import-job-1",
  });
  localRuntimePollJobStatusMock.mockReset();
  localRuntimePollJobStatusMock.mockImplementation(defaultLocalRuntimePollImpl);

  hatchLocalMock.mockReset();
  hatchLocalMock.mockResolvedValue(undefined);
  hatchDockerMock.mockReset();
  hatchDockerMock.mockResolvedValue(undefined);
  retireDockerMock.mockReset();
  retireDockerMock.mockResolvedValue(undefined);
  retireLocalMock.mockReset();
  retireLocalMock.mockResolvedValue(undefined);
  fetchCurrentVersionMock.mockReset();
  fetchCurrentVersionMock.mockResolvedValue(undefined);
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

/**
 * Tracking fetch mock — records every call so tests can verify that the CLI
 * never sends a bundle-sized request body. With the new GCS-unified flow
 * all bundle bytes travel between the runtime and GCS directly, so the CLI
 * should make zero fetch calls carrying binary payloads.
 */
function installTrackingFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCalls.push({ url: urlStr, body: init?.body });
      return new Response("not found", { status: 404 });
    },
  ) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
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

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot teleport between two local assistants"),
    );
  });

  test("source docker, target docker -> error", async () => {
    setArgv("--from", "src", "--docker", "dst");

    const srcEntry = makeEntry("src", { cloud: "docker" });
    const dstEntry = makeEntry("dst", { cloud: "docker" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "src") return srcEntry;
      if (name === "dst") return dstEntry;
      return null;
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot teleport between two docker assistants"),
    );
  });

  test("source vellum, target platform -> error", async () => {
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

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cannot teleport between two platform assistants",
      ),
    );
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
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("flag says docker but resolved target is local -> rejects cloud mismatch", async () => {
    setArgv("--from", "src", "--docker", "misidentified");

    const srcEntry = makeEntry("src", { cloud: "vellum" });
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
  });

  test("name not found -> hatch docker", async () => {
    const newEntry = makeEntry("new-one", { cloud: "docker" });
    findAssistantByNameMock.mockImplementation((name: string) => {
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

  test("no name -> hatch local, discovers via diff", async () => {
    const existingEntry = makeEntry("existing-local", { cloud: "local" });
    const newEntry = makeEntry("auto-generated", { cloud: "local" });

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchLocalMock.mock.calls.length > 0) {
        return [existingEntry, newEntry];
      }
      return [existingEntry];
    });

    const result = await resolveOrHatchTarget("local");
    expect(hatchLocalMock).toHaveBeenCalled();
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
    expect(result.assistantId).toBe("platform-new-id");
  });

  test("platform with no name -> blocks when hatch returns reusedExisting", async () => {
    findAssistantByNameMock.mockReturnValue(null);
    hatchAssistantMock.mockResolvedValue({
      assistant: {
        id: "existing-platform-id",
        name: "existing-platform",
        status: "active",
      },
      reusedExisting: true,
    });

    await expect(resolveOrHatchTarget("platform", undefined)).rejects.toThrow(
      "process.exit:1",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already have a platform assistant"),
    );
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
// Unified GCS teleport flow — the four directions
// ---------------------------------------------------------------------------

describe("unified GCS flow — four directions", () => {
  test("local → platform: requests upload URL, drives local runtime export, imports from GCS", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // Signed-URL request for upload — pinned to the platform target's URL
      // so upload and download land on the same platform.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "upload" }),
        "platform-token",
        "https://platform.vellum.ai",
      );

      // Runtime export-to-gcs kicked off with the signed upload URL.
      // Helper takes an entry, not a bare URL — the entry's cloud drives
      // URL construction (local → gateway loopback path).
      expect(localRuntimeExportToGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "local",
          runtimeUrl: "http://localhost:7821",
        }),
        "local-token",
        expect.objectContaining({
          uploadUrl: "https://storage.googleapis.com/bucket/signed-upload",
        }),
      );

      // Poll continued until complete
      expect(localRuntimePollJobStatusMock).toHaveBeenCalled();

      // Import via GCS with the bundleKey returned from signed-URL request
      expect(platformImportBundleFromGcsMock).toHaveBeenCalledWith(
        "bundle-key-123",
        "platform-token",
        expect.any(String),
      );

      // No download-URL request on the import side (platform target pulls
      // directly from GCS).
      const downloadOps = platformRequestSignedUrlMock.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { operation: string }).operation === "download",
      );
      expect(downloadOps.length).toBe(0);
    } finally {
      restoreFetch();
    }
  });

  test("platform → local: drives platform export, reads bundle_key, requests download URL for runtime import", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", {
      cloud: "local",
      bearerToken: "local-bearer",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    // Platform poll returns export-complete with a bundle_key.
    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "platform-exports/org-1/bundle-abc.vbundle",
    });

    // The bundle key now flows from the upload signed-URL request rather than
    // the job-status payload — pin it so the download-URL assertion below
    // still uses the same expected key.
    platformRequestSignedUrlMock.mockImplementation(async (params) => ({
      url:
        params.operation === "upload"
          ? "https://storage.googleapis.com/bucket/signed-upload"
          : "https://storage.googleapis.com/bucket/signed-download",
      bundleKey:
        params.bundleKey ?? "platform-exports/org-1/bundle-abc.vbundle",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // Platform side: requested an upload URL, kicked off a runtime export to
      // GCS, and polled the unified job status.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "upload" }),
        "platform-token",
        "https://platform.vellum.ai",
      );
      // For platform sources, export-to-gcs is reached via the platform's
      // wildcard runtime proxy. The helper builds the assistant-scoped URL
      // from the entry (`/v1/assistants/<id>/migrations/export-to-gcs`) and
      // sends platform-token auth — no guardian-token bootstrap.
      expect(localRuntimeExportToGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
          assistantId: "my-platform",
        }),
        "platform-token",
        expect.objectContaining({
          uploadUrl: "https://storage.googleapis.com/bucket/signed-upload",
          description: "teleport export",
        }),
      );
      // Polling for platform sources also goes through the wildcard via
      // localRuntimePollJobStatus(entry, ...) — the dedicated
      // `/v1/migrations/jobs/{id}/` endpoint queries platform-side
      // ImportJob records and would 404 on runtime-created job IDs.
      expect(localRuntimePollJobStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "vellum",
          runtimeUrl: "https://platform.vellum.ai",
        }),
        "platform-token",
        "local-export-job-1",
      );

      // For the local target we request a download URL keyed by the
      // platform's bundle_key. The URL must target the SOURCE platform
      // (where the bundle was written) — pinned so a lockfile change
      // can't split upload and download across instances.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        {
          operation: "download",
          bundleKey: "platform-exports/org-1/bundle-abc.vbundle",
        },
        "platform-token",
        "https://platform.vellum.ai",
      );

      // Runtime import-from-gcs was kicked off with that URL.
      expect(localRuntimeImportFromGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "local",
          runtimeUrl: "http://localhost:7821",
        }),
        "local-token",
        expect.objectContaining({
          bundleUrl: "https://storage.googleapis.com/bucket/signed-download",
        }),
      );
      expect(localRuntimePollJobStatusMock).toHaveBeenCalled();

      // No legacy inline-import helpers were touched.
      // (Verified by the absence of fetch calls carrying bundle bodies —
      // see "never buffers bundle bytes" assertion below.)
    } finally {
      restoreFetch();
    }
  });

  test("local → docker: export via upload URL, import via download URL", async () => {
    setArgv("--from", "my-local", "--docker");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("new-docker", {
      cloud: "docker",
      runtimeUrl: "http://localhost:7822",
    });

    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchDockerMock.mock.calls.length > 0) {
        return [localEntry, dockerEntry];
      }
      return [localEntry];
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // Export and import must pin the same platform URL so the bundle
      // lives in one place end-to-end. For local→docker neither side is
      // platform, so we default to getPlatformUrl() (resolved once).
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "upload" }),
        "platform-token",
        "https://platform.vellum.ai",
      );
      expect(localRuntimeExportToGcsMock).toHaveBeenCalled();

      // Import: download-URL for the docker target, then runtime import.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        {
          operation: "download",
          bundleKey: "bundle-key-123",
        },
        "platform-token",
        "https://platform.vellum.ai",
      );
      expect(localRuntimeImportFromGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "docker",
          runtimeUrl: "http://localhost:7822",
        }),
        "local-token",
        expect.objectContaining({
          bundleUrl: "https://storage.googleapis.com/bucket/signed-download",
        }),
      );

      // Source retirement still happens on success for local↔docker.
      expect(retireLocalMock).toHaveBeenCalledWith("my-local", localEntry);
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("my-local");
    } finally {
      restoreFetch();
    }
  });

  test("docker → local: export via upload URL, import via download URL", async () => {
    setArgv("--from", "my-docker", "--local");

    const dockerEntry = makeEntry("my-docker", {
      cloud: "docker",
      runtimeUrl: "http://localhost:7822",
    });
    const localEntry = makeEntry("new-local", {
      cloud: "local",
      runtimeUrl: "http://localhost:7823",
    });

    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-docker" ? dockerEntry : null,
    );

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchLocalMock.mock.calls.length > 0) {
        return [dockerEntry, localEntry];
      }
      return [dockerEntry];
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // Docker source should be put to sleep first.
      expect(sleepContainersMock).toHaveBeenCalled();

      // Export leg: upload-URL (pinned to the same platform as import),
      // then runtime export.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "upload" }),
        "platform-token",
        "https://platform.vellum.ai",
      );
      expect(localRuntimeExportToGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "docker",
          runtimeUrl: "http://localhost:7822",
        }),
        "local-token",
        expect.objectContaining({
          uploadUrl: "https://storage.googleapis.com/bucket/signed-upload",
        }),
      );

      // Import leg: download-URL targets the new local runtime
      expect(localRuntimeImportFromGcsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: "local",
          runtimeUrl: "http://localhost:7823",
        }),
        "local-token",
        expect.anything(),
      );

      // Source retirement
      expect(retireDockerMock).toHaveBeenCalledWith("my-docker");
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("my-docker");
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Target-platform URL threading: signed URL must be requested from the same
// platform instance the import will run against. Codex P2 regression guard.
// ---------------------------------------------------------------------------

describe("signed-URL request targets the bundle-owning platform", () => {
  test("local → existing platform target with non-default runtimeUrl: upload URL pinned to target's runtimeUrl", async () => {
    setArgv("--from", "my-local", "--platform", "existing-platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    // Crucially, the target's runtimeUrl is NOT the default getPlatformUrl()
    // return value — this is the regression case Codex flagged.
    const platformEntry = makeEntry("existing-platform", {
      cloud: "vellum",
      runtimeUrl: "https://staging-platform.vellum.ai",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      if (name === "existing-platform") return platformEntry;
      return null;
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // The signed-URL request for upload MUST target the existing
      // platform assistant's runtimeUrl, not the default platform URL.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "upload" }),
        "platform-token",
        "https://staging-platform.vellum.ai",
      );

      // And the import must run against the same platform.
      expect(platformImportBundleFromGcsMock).toHaveBeenCalledWith(
        "bundle-key-123",
        "platform-token",
        "https://staging-platform.vellum.ai",
      );

      // Assert none of the signed-URL calls used the default URL — if any
      // did, upload and download would hit different platforms.
      for (const call of platformRequestSignedUrlMock.mock.calls) {
        expect(call[2]).toBe("https://staging-platform.vellum.ai");
      }
    } finally {
      restoreFetch();
    }
  });

  test("platform → local with non-default source runtimeUrl: download URL pinned to source's runtimeUrl", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://dev-platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "dev-bundle-key",
    });

    // Bundle key flows from the upload signed-URL request now; pin it so the
    // download-URL assertion below uses the same key.
    platformRequestSignedUrlMock.mockImplementation(async (params) => ({
      url:
        params.operation === "upload"
          ? "https://storage.googleapis.com/bucket/signed-upload"
          : "https://storage.googleapis.com/bucket/signed-download",
      bundleKey: params.bundleKey ?? "dev-bundle-key",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // The download URL must be requested from the SOURCE platform (where
      // the bundle was written by the runtime export), not the default.
      expect(platformRequestSignedUrlMock).toHaveBeenCalledWith(
        { operation: "download", bundleKey: "dev-bundle-key" },
        "platform-token",
        "https://dev-platform.vellum.ai",
      );
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Invariants: CLI never buffers bundle bytes
// ---------------------------------------------------------------------------

describe("CLI never buffers bundle bytes", () => {
  // A teleport bundle is always > 1 KiB in practice; anything near that size
  // would mean the CLI is shuttling bytes when it shouldn't.
  const BUNDLE_BODY_THRESHOLD_BYTES = 1024;

  function bodySize(body: unknown): number {
    if (typeof body === "string") return body.length;
    if (body instanceof Uint8Array) return body.byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (body instanceof Blob) return body.size;
    return 0;
  }

  test("local → platform: no fetch call carries a bundle-sized body", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      for (const call of fetchCalls) {
        expect(bodySize(call.body)).toBeLessThan(BUNDLE_BODY_THRESHOLD_BYTES);
      }
    } finally {
      restoreFetch();
    }
  });

  test("platform → local: no fetch call carries a bundle-sized body", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "platform-exports/org-1/bundle.vbundle",
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      for (const call of fetchCalls) {
        expect(bodySize(call.body)).toBeLessThan(BUNDLE_BODY_THRESHOLD_BYTES);
      }
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Polling behavior
// ---------------------------------------------------------------------------

describe("polling", () => {
  test("local-runtime export poll continues until complete", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    let callIdx = 0;
    localRuntimePollJobStatusMock.mockImplementation(
      async (_runtimeUrl, _token, jobId) => {
        callIdx++;
        if (callIdx < 3) {
          return {
            jobId,
            type: "export" as const,
            status: "processing" as const,
          };
        }
        return {
          jobId,
          type: "export" as const,
          status: "complete" as const,
          result: undefined,
        };
      },
    );

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(callIdx).toBeGreaterThanOrEqual(3);
    } finally {
      restoreFetch();
    }
  });

  test("local-runtime export failure → teleport exits 1", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    localRuntimePollJobStatusMock.mockResolvedValue({
      jobId: "local-export-job-1",
      type: "export",
      status: "failed",
      error: "simulated failure",
    });

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("simulated failure"),
      );
    } finally {
      restoreFetch();
    }
  });

  test("local-runtime import failure → teleport exits 1", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "key-1",
    });

    localRuntimePollJobStatusMock.mockImplementation(
      async (_runtimeUrl, _token, jobId) => {
        if (jobId.includes("import")) {
          return {
            jobId,
            type: "import" as const,
            status: "failed" as const,
            error: "import blew up",
          };
        }
        return {
          jobId,
          type: "export" as const,
          status: "complete" as const,
          result: undefined,
        };
      },
    );

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("import blew up"),
      );
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// MigrationInProgressError handling
// ---------------------------------------------------------------------------

describe("MigrationInProgressError handling", () => {
  test("local-runtime export already in flight → fail fast with existing job id", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    localRuntimeExportToGcsMock.mockRejectedValue(
      new localRuntimeClient.MigrationInProgressError(
        "export_in_progress",
        "existing-job-42",
      ),
    );

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");

      // Must not have polled the existing job — the existing job's bundle
      // lives at a different GCS key (its caller's signed URL), so polling
      // it would leave the teleport pointing at an empty/unrelated bundle.
      const polledIds = localRuntimePollJobStatusMock.mock.calls.map(
        (call: unknown[]) => call[2],
      );
      expect(polledIds).not.toContain("existing-job-42");

      // Error must mention the existing job id so the user can act on it.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("existing-job-42"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("already in progress"),
      );
    } finally {
      restoreFetch();
    }
  });

  test("local-runtime import already in flight → fail fast with existing job id", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "bundle-key-from-platform",
    });

    localRuntimeImportFromGcsMock.mockRejectedValue(
      new localRuntimeClient.MigrationInProgressError(
        "import_in_progress",
        "existing-import-99",
      ),
    );

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");

      // Must not poll the existing import — it's importing somebody else's
      // bundle, not ours, so reporting on it would be misleading.
      const polledIds = localRuntimePollJobStatusMock.mock.calls.map(
        (call: unknown[]) => call[2],
      );
      expect(polledIds).not.toContain("existing-import-99");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("existing-import-99"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("already in progress"),
      );
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Dry-run behavior
// ---------------------------------------------------------------------------

describe("dry-run", () => {
  test("dry-run without existing target does not hatch or export", async () => {
    setArgv("--from", "my-local", "--docker", "--dry-run");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    await teleport();

    expect(hatchDockerMock).not.toHaveBeenCalled();
    expect(hatchLocalMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(retireDockerMock).not.toHaveBeenCalled();
    expect(localRuntimeExportToGcsMock).not.toHaveBeenCalled();
    expect(localRuntimeImportFromGcsMock).not.toHaveBeenCalled();
  });

  test("dry-run with existing platform target runs preflight-from-gcs", async () => {
    setArgv(
      "--from",
      "my-local",
      "--platform",
      "existing-platform",
      "--dry-run",
    );

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const platformEntry = makeEntry("existing-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      if (name === "existing-platform") return platformEntry;
      return null;
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(platformImportPreflightFromGcsMock).toHaveBeenCalledWith(
        "bundle-key-123",
        "platform-token",
        "https://platform.vellum.ai",
      );
      expect(hatchAssistantMock).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
    }
  });

  test("dry-run against local target fails fast (no preflight-from-gcs runtime endpoint yet)", async () => {
    setArgv("--from", "my-platform", "--local", "my-local", "--dry-run");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "bundle-key-from-platform",
    });

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "--dry-run is not yet supported for local or docker targets",
        ),
      );

      // Must fail BEFORE any export work — no signed URL request, no runtime
      // export kickoff, nothing that costs time or bandwidth.
      expect(platformRequestSignedUrlMock).not.toHaveBeenCalled();
      expect(localRuntimeExportToGcsMock).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-check: block teleport to platform when existing assistant detected
// ---------------------------------------------------------------------------

describe("pre-check: existing platform assistant", () => {
  test("blocks before any work when pre-check finds existing assistant", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    checkExistingPlatformAssistantMock.mockResolvedValue({
      id: "existing-platform-id",
      name: "existing-platform",
      status: "active",
    });

    await expect(teleport()).rejects.toThrow("process.exit:1");

    expect(checkExistingPlatformAssistantMock).toHaveBeenCalledWith(
      "platform-token",
      undefined,
    );
    // No signed-URL or runtime calls
    expect(platformRequestSignedUrlMock).not.toHaveBeenCalled();
    expect(localRuntimeExportToGcsMock).not.toHaveBeenCalled();
    expect(hatchAssistantMock).not.toHaveBeenCalled();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already have a platform assistant"),
    );
  });
});

// ---------------------------------------------------------------------------
// Version guard
// ---------------------------------------------------------------------------

describe("version guard", () => {
  test("blocks platform→local when local version is behind", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    fetchCurrentVersionMock.mockImplementation((url: string) => {
      if (url === "https://platform.vellum.ai") return Promise.resolve("0.7.0");
      return Promise.resolve("0.6.0");
    });

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("is running 0.6.0"),
      );
    } finally {
      restoreFetch();
    }
  });

  test("allows equal versions", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    fetchCurrentVersionMock.mockResolvedValue("0.7.0");
    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "b",
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Teleport complete"),
      );
    } finally {
      restoreFetch();
    }
  });

  test("newly hatched target is cleaned up when version check fails", async () => {
    setArgv("--from", "my-platform", "--local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const newLocalEntry = makeEntry("new-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-platform" ? platformEntry : null,
    );

    loadAllAssistantsMock.mockImplementation(() => {
      if (hatchLocalMock.mock.calls.length > 0) {
        return [platformEntry, newLocalEntry];
      }
      return [platformEntry];
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "b",
    });

    fetchCurrentVersionMock.mockImplementation((url: string) => {
      if (url === "https://platform.vellum.ai") return Promise.resolve("0.7.0");
      return Promise.resolve("0.6.0");
    });

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow("process.exit:1");
      expect(hatchLocalMock).toHaveBeenCalled();
      expect(retireLocalMock).toHaveBeenCalledWith("new-local", newLocalEntry);
      expect(removeAssistantEntryMock).toHaveBeenCalledWith("new-local");
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Credential import display
// ---------------------------------------------------------------------------

describe("credential import display", () => {
  test("prints credential counts when credentialsImported is present (platform target)", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    platformImportBundleFromGcsMock.mockResolvedValue({
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
        credentialsImported: {
          total: 5,
          succeeded: 5,
          failed: 0,
          failedAccounts: [],
        },
      },
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(consoleLogSpy).toHaveBeenCalledWith("  Credentials imported: 5/5");
    } finally {
      restoreFetch();
    }
  });

  test("does not print credential line when absent", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      const allLogCalls = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);
      const credentialLines = allLogCalls.filter(
        (msg: string) =>
          typeof msg === "string" && msg.includes("Credentials imported"),
      );
      expect(credentialLines).toHaveLength(0);
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Platform credential injection after teleport
// ---------------------------------------------------------------------------

describe("platform credential injection", () => {
  test("platform→local teleport calls ensureSelfHostedLocalRegistration and injectCredentialsIntoAssistant", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", {
      cloud: "local",
      bearerToken: "local-bearer",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "bundle-xyz",
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(ensureSelfHostedLocalRegistrationMock).toHaveBeenCalledWith(
        "platform-token",
        "org-1",
        "device-id-123",
        "my-local",
        "cli",
      );
      expect(injectCredentialsIntoAssistantMock).toHaveBeenCalledWith({
        gatewayUrl: "http://localhost:7821",
        bearerToken: "local-bearer",
        assistantApiKey: "api-key-123",
        platformAssistantId: "platform-assistant-1",
        platformBaseUrl: "https://platform.vellum.ai",
        organizationId: "org-1",
        userId: "user-1",
        webhookSecret: "webhook-secret-123",
      });
    } finally {
      restoreFetch();
    }
  });

  test("local→docker teleport does NOT call credential injection", async () => {
    setArgv("--from", "my-local", "--docker", "my-docker");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    const dockerEntry = makeEntry("my-docker", {
      cloud: "docker",
      runtimeUrl: "http://localhost:8821",
    });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-local") return localEntry;
      if (name === "my-docker") return dockerEntry;
      return null;
    });

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
      expect(ensureSelfHostedLocalRegistrationMock).not.toHaveBeenCalled();
      expect(injectCredentialsIntoAssistantMock).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth / transient-error resilience (Codex P1/P2 regression guards)
// ---------------------------------------------------------------------------

describe("auth + transient-error resilience", () => {
  test("runtime 401 on export kickoff triggers token refresh and retry", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    // First kickoff call fails with 401, second succeeds.
    localRuntimeExportToGcsMock.mockImplementationOnce(async () => {
      throw new Error("Local runtime export-to-gcs failed (401): stale token");
    });
    localRuntimeExportToGcsMock.mockImplementationOnce(async () => ({
      jobId: "local-export-job-after-refresh",
    }));

    // Ensure the refresh path returns a distinguishable token.
    leaseGuardianTokenMock.mockResolvedValueOnce({
      accessToken: "refreshed-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as Awaited<
      ReturnType<typeof guardianToken.leaseGuardianToken>
    >);

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
    } finally {
      restoreFetch();
    }

    // Kickoff was attempted twice: once with the cached token, once after
    // a forced refresh lease.
    expect(localRuntimeExportToGcsMock).toHaveBeenCalledTimes(2);

    const firstTokenArg = localRuntimeExportToGcsMock.mock.calls[0][1];
    const secondTokenArg = localRuntimeExportToGcsMock.mock.calls[1][1];
    expect(firstTokenArg).toBe("local-token");
    expect(secondTokenArg).toBe("refreshed-token");

    // A fresh lease was requested exactly once (the forceRefresh path).
    expect(leaseGuardianTokenMock).toHaveBeenCalledTimes(1);
  });

  test("runtime 401 on import kickoff triggers token refresh and retry", async () => {
    setArgv("--from", "my-platform", "--local", "my-local");

    const platformEntry = makeEntry("my-platform", {
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
    });
    const localEntry = makeEntry("my-local", { cloud: "local" });

    findAssistantByNameMock.mockImplementation((name: string) => {
      if (name === "my-platform") return platformEntry;
      if (name === "my-local") return localEntry;
      return null;
    });

    platformPollJobStatusMock.mockResolvedValue({
      jobId: "platform-export-job-1",
      type: "export",
      status: "complete",
      bundleKey: "b-key",
    });

    localRuntimeImportFromGcsMock.mockImplementationOnce(async () => {
      throw new Error(
        "Local runtime import-from-gcs failed (401): stale token",
      );
    });
    localRuntimeImportFromGcsMock.mockImplementationOnce(async () => ({
      jobId: "local-import-after-refresh",
    }));

    leaseGuardianTokenMock.mockResolvedValueOnce({
      accessToken: "refreshed-import-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as Awaited<
      ReturnType<typeof guardianToken.leaseGuardianToken>
    >);

    const restoreFetch = installTrackingFetch();
    try {
      await teleport();
    } finally {
      restoreFetch();
    }

    expect(localRuntimeImportFromGcsMock).toHaveBeenCalledTimes(2);
    expect(localRuntimeImportFromGcsMock.mock.calls[0][1]).toBe("local-token");
    expect(localRuntimeImportFromGcsMock.mock.calls[1][1]).toBe(
      "refreshed-import-token",
    );
  });

  test("runtime non-401 errors do NOT trigger token refresh", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    localRuntimeExportToGcsMock.mockRejectedValue(
      new Error("Local runtime export-to-gcs failed (500): boom"),
    );

    const restoreFetch = installTrackingFetch();
    try {
      await expect(teleport()).rejects.toThrow(/500.*boom/);
    } finally {
      restoreFetch();
    }

    // One attempt, no forced-refresh lease.
    expect(localRuntimeExportToGcsMock).toHaveBeenCalledTimes(1);
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("runtime poll 401 mid-migration triggers forceRefresh lease and completes", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    // Export kickoff succeeds with the cached "local-token".
    // During polling, the first status check fails with 401 (token expired
    // mid-migration), the poll loop calls refreshOn401 → leaseGuardianToken,
    // then the next poll succeeds with the new token.
    const tokensSeenByPoll: string[] = [];
    localRuntimePollJobStatusMock.mockImplementation(
      async (_runtimeUrl, token, jobId) => {
        tokensSeenByPoll.push(token);
        if (tokensSeenByPoll.length === 1) {
          throw new Error("Local job status check failed: 401 Unauthorized");
        }
        return {
          jobId,
          type: "export" as const,
          status: "complete" as const,
          result: undefined,
        };
      },
    );

    leaseGuardianTokenMock.mockResolvedValueOnce({
      accessToken: "poll-refreshed-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as Awaited<
      ReturnType<typeof guardianToken.leaseGuardianToken>
    >);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const restoreFetch = installTrackingFetch();
    try {
      await teleport();

      // The first poll used the cached token; the second (post-refresh) poll
      // used the freshly leased one.
      expect(tokensSeenByPoll.length).toBeGreaterThanOrEqual(2);
      expect(tokensSeenByPoll[0]).toBe("local-token");
      expect(tokensSeenByPoll[1]).toBe("poll-refreshed-token");

      // leaseGuardianToken was invoked for the forceRefresh path.
      expect(leaseGuardianTokenMock).toHaveBeenCalledTimes(1);

      // The 401 branch emits its own warning — distinct from the generic
      // transient-error warning — so this asserts the refresh path fired.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refreshing auth"),
      );
    } finally {
      restoreFetch();
      warnSpy.mockRestore();
    }
  });

  test("transient poll error does not abort teleport (job completes after retry)", async () => {
    setArgv("--from", "my-local", "--platform");

    const localEntry = makeEntry("my-local", { cloud: "local" });
    findAssistantByNameMock.mockImplementation((name: string) =>
      name === "my-local" ? localEntry : null,
    );

    // Throw once with a 503 (transient), then succeed with terminal complete.
    let pollCalls = 0;
    localRuntimePollJobStatusMock.mockImplementation(
      async (_runtimeUrl, _token, jobId) => {
        pollCalls += 1;
        if (pollCalls === 1) {
          throw new Error(
            "Local job status check failed: 503 Service Unavailable",
          );
        }
        return {
          jobId,
          type: "export" as const,
          status: "complete" as const,
          result: undefined,
        };
      },
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const restoreFetch = installTrackingFetch();
    try {
      // Should NOT reject — a single transient 503 is retried, not fatal.
      await teleport();
      expect(pollCalls).toBeGreaterThanOrEqual(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("polling failed, retrying"),
      );
    } finally {
      restoreFetch();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Misc: legacy --to deprecation
// ---------------------------------------------------------------------------

describe("misc", () => {
  test("legacy --to flag shows deprecation message", async () => {
    setArgv("--from", "source", "--to", "target");

    await expect(teleport()).rejects.toThrow("process.exit:1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--to is deprecated"),
    );
  });
});
