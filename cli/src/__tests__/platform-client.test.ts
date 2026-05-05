import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPlatformToken,
  fetchAssistantByIdFromPlatform,
  getPlatformUrl,
  readPlatformToken,
  savePlatformToken,
  type HatchedAssistant,
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

describe("fetchAssistantByIdFromPlatform", () => {
  interface CapturedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }

  function captureFetch(
    responder: (call: CapturedCall) => Response | Promise<Response>,
  ): {
    calls: CapturedCall[];
    fetchMock: typeof globalThis.fetch;
  } {
    const calls: CapturedCall[] = [];
    const fetchMock = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const rawHeaders = (init?.headers ?? {}) as
          | Record<string, string>
          | Headers;
        const headers: Record<string, string> = {};
        if (rawHeaders instanceof Headers) {
          rawHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else {
          Object.assign(headers, rawHeaders);
        }
        let parsedBody: unknown = undefined;
        const b = init?.body;
        if (typeof b === "string") {
          try {
            parsedBody = JSON.parse(b);
          } catch {
            parsedBody = b;
          }
        }
        const call: CapturedCall = {
          url: urlStr,
          method: init?.method ?? "GET",
          headers,
          body: parsedBody,
        };
        calls.push(call);
        return responder(call);
      },
    );
    return {
      calls,
      fetchMock: fetchMock as unknown as typeof globalThis.fetch,
    };
  }

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("200 → returns HatchedAssistant", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({ id: "uuid-123", name: "managed", status: "active" }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await fetchAssistantByIdFromPlatform(
      "vak_test_abc",
      "uuid-123",
      "https://platform.test",
    );

    expect(result).toEqual({
      id: "uuid-123",
      name: "managed",
      status: "active",
    } as HatchedAssistant);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://platform.test/v1/assistants/uuid-123/");
    expect(calls[0]!.method).toBe("GET");
  });

  test("404 → returns null", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await fetchAssistantByIdFromPlatform(
      "vak_test_abc",
      "uuid-missing",
      "https://platform.test",
    );

    expect(result).toBeNull();
  });

  test("401 → throws and logs human-readable line", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("", { status: 401 });
    });
    globalThis.fetch = fetchMock;

    const errSpy = mock(() => {});
    const origErr = console.error;
    console.error = errSpy as unknown as typeof console.error;
    try {
      await expect(
        fetchAssistantByIdFromPlatform(
          "vak_test_abc",
          "uuid-123",
          "https://platform.test",
        ),
      ).rejects.toThrow(/Run 'vellum login'/);
      // Direct-response 401 path must print a human-readable line so
      // interactive CLI users don't see only the structured CLI_ERROR JSON.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      console.error = origErr;
    }
  });

  test("auth-shaped error from authHeaders is normalized to standard sentinel", async () => {
    // Use a session token (non-vak_) so authHeaders calls fetchOrganizationId.
    // Stub /v1/organizations/ to 401 so fetchOrganizationId throws
    // "Failed to fetch organizations from ... (401). Try logging in again."
    // The new normalization path should rewrite that to the standard
    // "Authentication failed. Run 'vellum login' to refresh." sentinel so
    // the upgrade command's catch routes it to AUTH_FAILED.
    const { fetchMock } = captureFetch((call) => {
      if (call.url.includes("/v1/organizations/")) {
        return new Response("", { status: 401 });
      }
      // Should never reach the assistants endpoint on this path.
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    // Silence the console.error inside authHeaders' catch block.
    const errSpy = mock(() => {});
    const origErr = console.error;
    console.error = errSpy as unknown as typeof console.error;
    try {
      await expect(
        fetchAssistantByIdFromPlatform(
          "session-token",
          "uuid-123",
          "https://platform.test",
        ),
      ).rejects.toThrow(
        "Authentication failed. Run 'vellum login' to refresh.",
      );
    } finally {
      console.error = origErr;
    }
  });
});
