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

import * as platformClient from "../lib/platform-client.js";
import {
  createGatewayBackup,
  createPlatformBackup,
  hasRecentBackup,
  listGatewayBackups,
  listPlatformBackups,
  RECENT_BACKUP_MAX_AGE_MS,
} from "../lib/teleport-backup.js";

const authHeadersSpy = spyOn(platformClient, "authHeaders").mockResolvedValue({
  "Content-Type": "application/json",
  "X-Session-Token": "platform-token",
  "Vellum-Organization-Id": "org-1",
});
const invalidateOrgIdCacheSpy = spyOn(
  platformClient,
  "invalidateOrgIdCache",
).mockImplementation(() => {});

afterAll(() => {
  authHeadersSpy.mockRestore();
  invalidateOrgIdCacheSpy.mockRestore();
});

const NOW = Date.parse("2026-09-15T12:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("hasRecentBackup", () => {
  test("true when a backup is within the max age", () => {
    expect(hasRecentBackup([ago(5 * 60_000)], NOW)).toBe(true);
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS)], NOW)).toBe(true);
  });

  test("false when every backup is older than the max age", () => {
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS + 1)], NOW)).toBe(
      false,
    );
  });

  test("false with no backups", () => {
    expect(hasRecentBackup([], NOW)).toBe(false);
  });

  test("ignores empty, missing, unparseable and future timestamps", () => {
    expect(
      hasRecentBackup(["", undefined, null, "garbage", ago(-60_000)], NOW),
    ).toBe(false);
    expect(hasRecentBackup(["", "garbage", ago(60_000)], NOW)).toBe(true);
  });

  test("honors a custom max age", () => {
    expect(hasRecentBackup([ago(10 * 60_000)], NOW, 5 * 60_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; method: string; headers: HeadersInit }>;
let responses: Response[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  responses = [];
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof url === "string" ? url : url.toString(),
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
      });
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected fetch");
      }
      return next;
    },
  ) as unknown as typeof globalThis.fetch;
  authHeadersSpy.mockClear();
  invalidateOrgIdCacheSpy.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const GATEWAY_ENTRY = { runtimeUrl: "http://localhost:7821" };
const PLATFORM_ENTRY = {
  runtimeUrl: "https://platform.vellum.ai",
  assistantId: "11111111-2222-3333-4444-555555555555",
};

describe("listGatewayBackups", () => {
  test("returns created_at of the local snapshot pool", async () => {
    responses.push(
      Response.json({
        local: {
          directory: "/backups",
          snapshots: [
            { filename: "a", created_at: "2026-09-15T11:00:00.000Z" },
            { filename: "b" },
          ],
        },
        offsite: [],
      }),
    );

    const result = await listGatewayBackups(GATEWAY_ENTRY, "guardian-token");

    expect(result).toEqual(["2026-09-15T11:00:00.000Z", ""]);
    expect(fetchCalls[0]).toMatchObject({
      url: "http://localhost:7821/v1/backups",
      method: "GET",
    });
    expect(
      (fetchCalls[0].headers as Record<string, string>).Authorization,
    ).toBe("Bearer guardian-token");
  });

  test("throws in the runtime-401 shape on a rejected token", async () => {
    responses.push(new Response("unauthorized", { status: 401 }));

    await expect(
      listGatewayBackups(GATEWAY_ENTRY, "stale-token"),
    ).rejects.toThrow(/Local runtime backup list failed \(401\)/);
  });
});

describe("createGatewayBackup", () => {
  test("posts to /v1/backups/create and resolves on success", async () => {
    responses.push(Response.json({ success: true }));

    await createGatewayBackup(GATEWAY_ENTRY, "guardian-token");

    expect(fetchCalls[0]).toMatchObject({
      url: "http://localhost:7821/v1/backups/create",
      method: "POST",
    });
  });

  test("throws on a non-2xx status with the body", async () => {
    responses.push(new Response("disk full", { status: 500 }));

    await expect(
      createGatewayBackup(GATEWAY_ENTRY, "guardian-token"),
    ).rejects.toThrow("Local runtime backup create failed (500): disk full");
  });

  test("throws on a 2xx body reporting failure", async () => {
    responses.push(Response.json({ success: false }));

    await expect(
      createGatewayBackup(GATEWAY_ENTRY, "guardian-token"),
    ).rejects.toThrow("reported failure");
  });
});

describe("listPlatformBackups", () => {
  test("returns created_at of ready snapshots only", async () => {
    responses.push(
      Response.json({
        backups: [
          { created_at: "2026-09-15T11:00:00Z", ready_to_use: true },
          { created_at: "2026-09-15T11:30:00Z", ready_to_use: false },
          { created_at: "2026-09-15T10:00:00Z" },
        ],
      }),
    );

    const result = await listPlatformBackups(PLATFORM_ENTRY, "platform-token");

    expect(result).toEqual(["2026-09-15T11:00:00Z", "2026-09-15T10:00:00Z"]);
    expect(fetchCalls[0]).toMatchObject({
      url: `https://platform.vellum.ai/v1/assistants/${PLATFORM_ENTRY.assistantId}/backups/`,
      method: "GET",
    });
    expect(authHeadersSpy).toHaveBeenCalledWith(
      "platform-token",
      "https://platform.vellum.ai",
    );
  });

  test("refreshes the org id cache and retries once on 401", async () => {
    responses.push(new Response("unauthorized", { status: 401 }));
    responses.push(Response.json({ backups: [] }));

    const result = await listPlatformBackups(PLATFORM_ENTRY, "platform-token");

    expect(result).toEqual([]);
    expect(fetchCalls).toHaveLength(2);
    expect(invalidateOrgIdCacheSpy).toHaveBeenCalledWith(
      "platform-token",
      "https://platform.vellum.ai",
    );
  });

  test("throws on a persistent error", async () => {
    responses.push(new Response("Bad gateway", { status: 502 }));

    await expect(
      listPlatformBackups(PLATFORM_ENTRY, "platform-token"),
    ).rejects.toThrow("Platform backup list failed (502): Bad gateway");
  });
});

describe("createPlatformBackup", () => {
  test("posts to the assistant backups endpoint", async () => {
    responses.push(Response.json({ snapshot_name: "snap-1" }, { status: 201 }));

    await createPlatformBackup(PLATFORM_ENTRY, "platform-token");

    expect(fetchCalls[0]).toMatchObject({
      url: `https://platform.vellum.ai/v1/assistants/${PLATFORM_ENTRY.assistantId}/backups/`,
      method: "POST",
    });
  });

  test("throws on a non-2xx status", async () => {
    responses.push(new Response('{"detail":"Bad gateway"}', { status: 502 }));

    await expect(
      createPlatformBackup(PLATFORM_ENTRY, "platform-token"),
    ).rejects.toThrow("Platform backup create failed (502)");
  });
});
