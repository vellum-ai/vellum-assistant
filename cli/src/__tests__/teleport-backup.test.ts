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
  createPlatformBackup,
  listPlatformBackups,
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

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; method: string }>;
let responses: Array<() => Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  responses = [];
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof url === "string" ? url : url.toString(),
        method: init?.method ?? "GET",
      });
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected fetch");
      }
      return next();
    },
  ) as unknown as typeof globalThis.fetch;
  authHeadersSpy.mockClear();
  invalidateOrgIdCacheSpy.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ENTRY = {
  runtimeUrl: "https://platform.vellum.ai",
  assistantId: "11111111-2222-3333-4444-555555555555",
};
const BACKUPS_URL = `https://platform.vellum.ai/v1/assistants/${ENTRY.assistantId}/backups/`;
const FAST_POLL = { pollIntervalMs: 1, timeoutMs: 200 };

function json(body: unknown, status = 200): () => Response {
  return () => Response.json(body, { status });
}

describe("listPlatformBackups", () => {
  test("returns created_at of ready snapshots only", async () => {
    responses.push(
      json({
        backups: [
          { created_at: "2026-09-15T11:00:00Z", ready_to_use: true },
          { created_at: "2026-09-15T11:30:00Z", ready_to_use: false },
          { created_at: "2026-09-15T10:00:00Z" },
        ],
      }),
    );

    const result = await listPlatformBackups(ENTRY, "platform-token");

    expect(result).toEqual(["2026-09-15T11:00:00Z", "2026-09-15T10:00:00Z"]);
    expect(fetchCalls[0]).toEqual({ url: BACKUPS_URL, method: "GET" });
    expect(authHeadersSpy).toHaveBeenCalledWith(
      "platform-token",
      "https://platform.vellum.ai",
    );
  });

  test("refreshes the org id cache and retries once on 401", async () => {
    responses.push(() => new Response("unauthorized", { status: 401 }));
    responses.push(json({ backups: [] }));

    const result = await listPlatformBackups(ENTRY, "platform-token");

    expect(result).toEqual([]);
    expect(fetchCalls).toHaveLength(2);
    expect(invalidateOrgIdCacheSpy).toHaveBeenCalledWith(
      "platform-token",
      "https://platform.vellum.ai",
    );
  });

  test("throws on a persistent error", async () => {
    responses.push(() => new Response("Bad gateway", { status: 502 }));

    await expect(listPlatformBackups(ENTRY, "platform-token")).rejects.toThrow(
      "Platform backup list failed (502): Bad gateway",
    );
  });
});

describe("createPlatformBackup", () => {
  test("returns immediately when the POST reports the snapshot ready", async () => {
    responses.push(json({ snapshot_name: "snap-1", ready_to_use: true }, 201));

    await createPlatformBackup(ENTRY, "platform-token", FAST_POLL);

    expect(fetchCalls).toEqual([{ url: BACKUPS_URL, method: "POST" }]);
  });

  test("polls the listing until the new snapshot is ready", async () => {
    responses.push(json({ snapshot_name: "snap-1", ready_to_use: false }, 201));
    responses.push(
      json({ backups: [{ snapshot_name: "snap-1", ready_to_use: false }] }),
    );
    responses.push(
      json({
        backups: [
          { snapshot_name: "older", ready_to_use: true },
          { snapshot_name: "snap-1", ready_to_use: true },
        ],
      }),
    );

    await createPlatformBackup(ENTRY, "platform-token", FAST_POLL);

    expect(fetchCalls.map((call) => call.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
  });

  test("another ready snapshot does not satisfy the wait", async () => {
    responses.push(json({ snapshot_name: "snap-1" }, 201));
    responses.push(
      json({ backups: [{ snapshot_name: "older", ready_to_use: true }] }),
    );
    responses.push(
      json({ backups: [{ snapshot_name: "snap-1", ready_to_use: true }] }),
    );

    await createPlatformBackup(ENTRY, "platform-token", FAST_POLL);

    expect(fetchCalls).toHaveLength(3);
  });

  test("throws when the snapshot is not ready before the timeout", async () => {
    responses.push(json({ snapshot_name: "snap-1", ready_to_use: false }, 201));
    const pending = json({
      backups: [{ snapshot_name: "snap-1", ready_to_use: false }],
    });
    for (let i = 0; i < 1000; i++) {
      responses.push(pending);
    }

    await expect(
      createPlatformBackup(ENTRY, "platform-token", {
        pollIntervalMs: 1,
        timeoutMs: 30,
      }),
    ).rejects.toThrow("Platform backup snap-1 was not ready after 0s");
  });

  test("throws when the POST fails", async () => {
    responses.push(
      () => new Response('{"detail":"Bad gateway"}', { status: 502 }),
    );

    await expect(
      createPlatformBackup(ENTRY, "platform-token", FAST_POLL),
    ).rejects.toThrow("Platform backup create failed (502)");
    expect(fetchCalls).toHaveLength(1);
  });

  test("throws when the POST returns no snapshot name", async () => {
    responses.push(json({}, 201));

    await expect(
      createPlatformBackup(ENTRY, "platform-token", FAST_POLL),
    ).rejects.toThrow("no snapshot name");
  });

  test("a listing failure while waiting is fatal", async () => {
    responses.push(json({ snapshot_name: "snap-1" }, 201));
    responses.push(() => new Response("Bad gateway", { status: 502 }));

    await expect(
      createPlatformBackup(ENTRY, "platform-token", FAST_POLL),
    ).rejects.toThrow("Platform backup list failed (502)");
  });
});
