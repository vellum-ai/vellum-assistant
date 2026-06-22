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
  let savedEnv: string | undefined;
  let savedPlatformUrl: string | undefined;

  beforeEach(() => {
    savedLockDir = process.env.VELLUM_LOCKFILE_DIR;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    savedPlatformUrl = process.env.VELLUM_PLATFORM_URL;
    tempLockDir = mkdtempSync(join(tmpdir(), "cli-platform-url-test-"));
    process.env.VELLUM_LOCKFILE_DIR = tempLockDir;
    delete process.env.VELLUM_ENVIRONMENT;
    delete process.env.VELLUM_PLATFORM_URL;
  });

  afterEach(() => {
    if (savedLockDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = savedLockDir;
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
    const detail = await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL);
    expect(detail).toEqual({
      currentReleaseVersion: "0.7.0",
      releaseChannel: "preview",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/`);
  });

  test("fetchAssistantDetail defaults missing fields", async () => {
    mockFetchJson({});
    const detail = await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL);
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
