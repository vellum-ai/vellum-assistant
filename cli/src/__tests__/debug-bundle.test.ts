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

// Lockfile isolation (mirrors backup.test.ts)
const testDir = mkdtempSync(join(tmpdir(), "cli-debug-bundle-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as localRuntimeClient from "../lib/local-runtime-client.js";
import * as platformClient from "../lib/platform-client.js";

const resolveTargetMock = spyOn(
  assistantConfig,
  "resolveTargetAssistant",
).mockImplementation(() => {
  throw new Error("process.exit:1");
});
const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue("platform-token");
const exportMock = spyOn(
  localRuntimeClient,
  "localRuntimeExportToGcs",
).mockResolvedValue({ jobId: "job-1" });
const identityMock = spyOn(
  localRuntimeClient,
  "localRuntimeIdentity",
).mockResolvedValue({ version: "0.12.3" });
const pollMock = spyOn(
  localRuntimeClient,
  "localRuntimePollJobStatus",
).mockResolvedValue({
  jobId: "job-1",
  type: "export",
  status: "complete",
} as unknown as Awaited<
  ReturnType<typeof localRuntimeClient.localRuntimePollJobStatus>
>);
const loadGuardianTokenSpy = spyOn(
  guardianToken,
  "loadGuardianToken",
).mockReturnValue({
  accessToken: "local-token",
  accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
} as unknown as ReturnType<typeof guardianToken.loadGuardianToken>);
const leaseGuardianTokenSpy = spyOn(
  guardianToken,
  "leaseGuardianToken",
).mockResolvedValue({
  accessToken: "leased-token",
  accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
} as unknown as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>);

const { debugBundle } = await import("../commands/debug-bundle.js");

const LOCAL_ENTRY = {
  name: "mine",
  assistantId: "local-asst-1",
  runtimeUrl: "http://127.0.0.1:7821",
  cloud: "local",
  species: "local",
  hatchedAt: new Date().toISOString(),
  platformAssistantId: "11111111-2222-3333-4444-555555555555",
  platformBaseUrl: "https://platform.vellum.ai",
  platformOrganizationId: "org-1",
} as unknown as assistantConfig.AssistantEntry;

let originalFetch: typeof globalThis.fetch;
let originalExit: typeof process.exit;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let uploadUrlStatus = 201;

beforeEach(() => {
  process.argv = ["bun", "vellum", "debug-bundle"];
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
  process.exit = mock((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as unknown as typeof process.exit;
  fetchCalls = [];
  uploadUrlStatus = 201;
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ url: "https://storage.googleapis.com/b/signed" }),
        {
          status: uploadUrlStatus,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  ) as unknown as typeof globalThis.fetch;
  resolveTargetMock.mockReset();
  resolveTargetMock.mockReturnValue(LOCAL_ENTRY);
  identityMock.mockReset();
  identityMock.mockResolvedValue({ version: "0.12.3" });
  leaseGuardianTokenSpy.mockClear();
  readPlatformTokenMock.mockReset();
  readPlatformTokenMock.mockReturnValue("platform-token");
  exportMock.mockClear();
  pollMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
});

afterAll(() => {
  resolveTargetMock.mockRestore();
  identityMock.mockRestore();
  leaseGuardianTokenSpy.mockRestore();
  readPlatformTokenMock.mockRestore();
  exportMock.mockRestore();
  pollMock.mockRestore();
  loadGuardianTokenSpy.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("vellum debug-bundle", () => {
  test("mints the URL on the platform, exports with the debug profile, and waits", async () => {
    await debugBundle();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/debug-bundle-upload-url/",
    );
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(
      (fetchCalls[0].init?.headers as Record<string, string>)[
        "Vellum-Organization-Id"
      ],
    ).toBe("org-1");

    expect(exportMock).toHaveBeenCalledTimes(1);
    const [entry, token, params] = exportMock.mock.calls[0];
    expect(entry).toBe(LOCAL_ENTRY);
    expect(token).toBe("local-token");
    expect(params).toEqual({
      uploadUrl: "https://storage.googleapis.com/b/signed",
      description: "debug bundle for Vellum staff",
      profile: "debug",
    });
    expect(pollMock).toHaveBeenCalled();
    // The daemon was checked for the debug profile before the platform call.
    expect(identityMock).toHaveBeenCalledTimes(1);
  });

  test("passes an unquoted multi-word display name through to the shared resolver", async () => {
    process.argv = ["bun", "vellum", "debug-bundle", "Support", "Bot"];
    await debugBundle();
    expect(resolveTargetMock).toHaveBeenCalledWith("Support Bot");
  });

  test("refuses a daemon older than the debug profile before any URL is minted", async () => {
    // Such a daemon strips `profile` and would upload the owner's
    // credentials to the staff bucket.
    identityMock.mockResolvedValue({ version: "0.12.2" });
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debugBundle()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("0.12.3");
    expect(fetchCalls).toHaveLength(0);
    expect(exportMock).not.toHaveBeenCalled();
  });

  test("re-leases the guardian token when the daemon answers 401 mid-poll", async () => {
    pollMock.mockReset();
    let polls = 0;
    pollMock.mockImplementation(async (_entry, token) => {
      polls += 1;
      if (polls === 1) {
        throw new Error("Local job status check failed: 401 Unauthorized");
      }
      expect(token).toBe("leased-token");
      return {
        jobId: "job-1",
        type: "export",
        status: "complete",
      } as unknown as Awaited<
        ReturnType<typeof localRuntimeClient.localRuntimePollJobStatus>
      >;
    });

    await debugBundle();

    expect(leaseGuardianTokenSpy).toHaveBeenCalledTimes(1);
    expect(polls).toBe(2);
  });

  test("explains what to turn on when the platform refuses", async () => {
    uploadUrlStatus = 403;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debugBundle()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("Allow Staff Access");
    expect(exportMock).not.toHaveBeenCalled();
  });

  test("refuses a Vellum-hosted assistant, which needs no bundle", async () => {
    resolveTargetMock.mockReturnValue({
      ...LOCAL_ENTRY,
      cloud: "vellum",
    } as unknown as assistantConfig.AssistantEntry);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(debugBundle()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(fetchCalls).toHaveLength(0);
  });

  test("asks for a login when the assistant is not registered", async () => {
    resolveTargetMock.mockReturnValue({
      ...LOCAL_ENTRY,
      platformAssistantId: undefined,
    } as unknown as assistantConfig.AssistantEntry);
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debugBundle()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("vellum login");
    expect(fetchCalls).toHaveLength(0);
  });
});
