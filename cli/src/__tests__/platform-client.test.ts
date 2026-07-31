import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mock } from "bun:test";

import {
  clearPlatformToken,
  fetchAssistantDetail,
  fetchUpgradeInProgress,
  getPlatformUrl,
  invalidateOrgIdCache,
  LiveVoiceTokenMintError,
  mintLiveVoiceToken,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client.js";

describe("platform-client token path is env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-platform-client-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod (VELLUM_ENVIRONMENT unset) writes to $XDG_CONFIG_HOME/vellum/platform-token", () => {
    const token = "vak_prod_token_123";
    savePlatformToken(token);

    const prodPath = join(tempHome, "vellum", "platform-token");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(token);
    expect(readPlatformToken()).toBe(token);
  });

  test("dev (VELLUM_ENVIRONMENT=dev) writes to $XDG_CONFIG_HOME/vellum-dev/platform-token", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const token = "vak_dev_token_456";
    savePlatformToken(token);

    const devPath = join(tempHome, "vellum-dev", "platform-token");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(token);

    const prodPath = join(tempHome, "vellum", "platform-token");
    expect(existsSync(prodPath)).toBe(false);

    expect(readPlatformToken()).toBe(token);
  });

  test("prod and dev tokens are isolated on disk", () => {
    // Save prod token
    delete process.env.VELLUM_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Switch to dev and save a different token
    process.env.VELLUM_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Dev read returns dev
    expect(readPlatformToken()).toBe("dev-token");

    // Switch back to prod — prod value is unchanged
    delete process.env.VELLUM_ENVIRONMENT;
    expect(readPlatformToken()).toBe("prod-token");

    // Files live at distinct paths
    expect(
      readFileSync(join(tempHome, "vellum", "platform-token"), "utf-8").trim(),
    ).toBe("prod-token");
    expect(
      readFileSync(
        join(tempHome, "vellum-dev", "platform-token"),
        "utf-8",
      ).trim(),
    ).toBe("dev-token");
  });

  test("clearPlatformToken removes only the env-scoped token", () => {
    // Prod token
    delete process.env.VELLUM_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Dev token
    process.env.VELLUM_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Clear dev
    clearPlatformToken();
    expect(existsSync(join(tempHome, "vellum-dev", "platform-token"))).toBe(
      false,
    );

    // Prod still there
    expect(existsSync(join(tempHome, "vellum", "platform-token"))).toBe(true);
  });
});

describe("getPlatformUrl resolution order", () => {
  let tempLockDir: string;
  let savedLockDir: string | undefined;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;
  let savedPlatformUrl: string | undefined;

  beforeEach(() => {
    savedLockDir = process.env.VELLUM_LOCKFILE_DIR;
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    savedPlatformUrl = process.env.VELLUM_PLATFORM_URL;
    tempLockDir = mkdtempSync(join(tmpdir(), "cli-platform-url-test-"));
    process.env.VELLUM_LOCKFILE_DIR = tempLockDir;
    process.env.XDG_CONFIG_HOME = tempLockDir;
    delete process.env.VELLUM_ENVIRONMENT;
    delete process.env.VELLUM_PLATFORM_URL;
  });

  afterEach(() => {
    if (savedLockDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = savedLockDir;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
    if (savedPlatformUrl === undefined) {
      delete process.env.VELLUM_PLATFORM_URL;
    } else {
      process.env.VELLUM_PLATFORM_URL = savedPlatformUrl;
    }
    rmSync(tempLockDir, { recursive: true, force: true });
  });

  function writeLockfile(data: Record<string, unknown>): void {
    // VELLUM_ENVIRONMENT is unset → production env → `.vellum.lock.json`.
    writeFileSync(
      join(tempLockDir, ".vellum.lock.json"),
      JSON.stringify(data, null, 2),
    );
  }

  test("returns lockfile platformBaseUrl when set", () => {
    writeLockfile({ platformBaseUrl: "https://staging.vellum.ai" });
    expect(getPlatformUrl()).toBe("https://staging.vellum.ai");
  });

  test("lockfile platformBaseUrl takes priority over VELLUM_PLATFORM_URL", () => {
    writeLockfile({ platformBaseUrl: "https://lockfile.vellum.ai" });
    process.env.VELLUM_PLATFORM_URL = "https://env.vellum.ai";
    expect(getPlatformUrl()).toBe("https://lockfile.vellum.ai");
  });

  test("falls back to VELLUM_PLATFORM_URL when lockfile is missing", () => {
    process.env.VELLUM_PLATFORM_URL = "https://env-only.vellum.ai";
    expect(getPlatformUrl()).toBe("https://env-only.vellum.ai");
  });

  test("falls back to VELLUM_PLATFORM_URL when lockfile has no platformBaseUrl", () => {
    writeLockfile({ assistants: [] });
    process.env.VELLUM_PLATFORM_URL = "https://env-fallback.vellum.ai";
    expect(getPlatformUrl()).toBe("https://env-fallback.vellum.ai");
  });

  test("falls back to VELLUM_PLATFORM_URL when lockfile platformBaseUrl is blank", () => {
    writeLockfile({ platformBaseUrl: "   " });
    process.env.VELLUM_PLATFORM_URL = "https://env-after-blank.vellum.ai";
    expect(getPlatformUrl()).toBe("https://env-after-blank.vellum.ai");
  });

  test("falls back to prod env seed URL when lockfile and VELLUM_PLATFORM_URL are unset (prod env)", () => {
    // VELLUM_ENVIRONMENT is unset → production → prod seed URL.
    expect(getPlatformUrl()).toBe("https://platform.vellum.ai");
  });

  test("falls back to dev env seed URL when VELLUM_ENVIRONMENT=dev", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    expect(getPlatformUrl()).toBe("https://dev-platform.vellum.ai");
  });

  test("trims whitespace from VELLUM_PLATFORM_URL", () => {
    process.env.VELLUM_PLATFORM_URL = "  https://trimmed.vellum.ai  ";
    expect(getPlatformUrl()).toBe("https://trimmed.vellum.ai");
  });
});

describe("fetchAssistantDetail / fetchUpgradeInProgress", () => {
  // vak_ token → authHeaders skips the org-ID fetch, so the single mocked
  // fetch call is the endpoint under test.
  const TOKEN = "vak_test_token";
  const ASSISTANT_ID = "11111111-2222-3333-4444-555555555555";
  const PLATFORM_URL = "https://platform.test";

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchJson(body: unknown, status = 200) {
    const fetchMock = mock(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return fetchMock;
  }

  function mockFetchNetworkError() {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
  }

  test("fetchAssistantDetail maps fields", async () => {
    const fetchMock = mockFetchJson({
      current_release_version: "0.7.0",
      release_channel: "preview",
    });
    const detail = await fetchAssistantDetail(
      TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );
    expect(detail).toEqual({
      currentReleaseVersion: "0.7.0",
      releaseChannel: "preview",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/`);
  });

  test("fetchAssistantDetail defaults missing fields", async () => {
    mockFetchJson({});
    const detail = await fetchAssistantDetail(
      TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );
    expect(detail).toEqual({
      currentReleaseVersion: null,
      releaseChannel: "stable",
    });
  });

  test("fetchAssistantDetail returns null on non-OK", async () => {
    mockFetchJson({ detail: "not found" }, 404);
    expect(
      await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchAssistantDetail returns null on network error", async () => {
    mockFetchNetworkError();
    expect(
      await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns the boolean", async () => {
    const fetchMock = mockFetchJson({ in_progress: true });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(
      `${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/upgrade-status/`,
    );

    mockFetchJson({ in_progress: false });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBe(false);
  });

  test("fetchUpgradeInProgress returns null on 404 (older platform)", async () => {
    mockFetchJson({ detail: "not found" }, 404);
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns null on network error", async () => {
    mockFetchNetworkError();
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns null on a malformed body", async () => {
    mockFetchJson({ something_else: 1 });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });
});

describe("mintLiveVoiceToken", () => {
  const SESSION_TOKEN = "session-token-value";
  const ASSISTANT_ID = "11111111-2222-3333-4444-555555555555";
  const PLATFORM_URL = "https://platform.example.com";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateOrgIdCache(SESSION_TOKEN, PLATFORM_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateOrgIdCache(SESSION_TOKEN, PLATFORM_URL);
  });

  test("mints with session and organization headers", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    globalThis.fetch = mock(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/v1/organizations/")) {
          return Response.json({
            results: [{ id: "org-abc", name: "Example Organization" }],
          });
        }
        return Response.json({
          token: "minted-token",
          expiresAt,
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const result = await mintLiveVoiceToken(
      SESSION_TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );

    expect(result).toEqual({
      token: "minted-token",
      expiresAt,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(`${PLATFORM_URL}/v1/auth/live-voice-token/`);
    expect(requests[1]?.init?.method).toBe("POST");
    const headers = new Headers(requests[1]?.init?.headers);
    expect(headers.get("X-Session-Token")).toBe(SESSION_TOKEN);
    expect(headers.get("Vellum-Organization-Id")).toBe("org-abc");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      assistantId: ASSISTANT_ID,
    });
  });

  test("rejects platform API keys before making a request", async () => {
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      mintLiveVoiceToken("vak_example", ASSISTANT_ID, PLATFORM_URL),
    ).rejects.toMatchObject({
      name: "LiveVoiceTokenMintError",
      code: "api_key_unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects malformed token responses without exposing the token", async () => {
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/v1/organizations/")) {
        return Response.json({
          results: [{ id: "org-abc", name: "Example Organization" }],
        });
      }
      return Response.json({
        token: "secret-minted-token",
        expiresAt: 123,
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await mintLiveVoiceToken(SESSION_TOKEN, ASSISTANT_ID, PLATFORM_URL);
      throw new Error("Expected token minting to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceTokenMintError);
      expect((error as LiveVoiceTokenMintError).code).toBe(
        "malformed_response",
      );
      expect(String(error)).not.toContain("secret-minted-token");
      expect(String(error)).not.toContain(SESSION_TOKEN);
    }
  });

  test("does not include platform error bodies or credentials in errors", async () => {
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/v1/organizations/")) {
        return Response.json({
          results: [{ id: "org-abc", name: "Example Organization" }],
        });
      }
      return Response.json(
        { detail: "secret-response-value" },
        { status: 503 },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      await mintLiveVoiceToken(SESSION_TOKEN, ASSISTANT_ID, PLATFORM_URL);
      throw new Error("Expected token minting to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceTokenMintError);
      expect((error as LiveVoiceTokenMintError).status).toBe(503);
      expect(String(error)).not.toContain("secret-response-value");
      expect(String(error)).not.toContain(SESSION_TOKEN);
    }
  });
});
