import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getAssistant,
  hatchAssistant,
  listAssistantBackups,
  restoreAssistantBackup,
} from "@/lib/assistants/api.js";

const BACKUP_A = {
  snapshot_name: "assistant-data-assistant-abc-0-pit-20240102t120000000000z",
  pvc: "assistant-data-assistant-abc-0",
  created_at: "2024-01-02T12:00:00Z",
  ready_to_use: true,
  backup_type: "point_in_time",
};

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = mock(async () =>
    Response.json(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function getRequestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (value instanceof Request) {
    return value.url;
  }
  return String(value);
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listAssistantBackups", () => {
  test("returns backup list on success", async () => {
    mockFetch(200, { backups: [BACKUP_A] });

    const result = await listAssistantBackups("abc");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual([BACKUP_A]);
    }
  });

  test("returns empty array when backups is empty", async () => {
    mockFetch(200, { backups: [] });

    const result = await listAssistantBackups("abc");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  test("returns error on upstream failure", async () => {
    mockFetch(500, { detail: "Failed to list backups" });

    const result = await listAssistantBackups("abc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toEqual({ detail: "Failed to list backups" });
    }
  });

  test("returns error on 502", async () => {
    mockFetch(502, { detail: "Bad gateway" });

    const result = await listAssistantBackups("abc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
    }
  });

  test("calls correct URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      capturedUrl = getRequestUrl(url);
      return Response.json({ backups: [] });
    }) as unknown as typeof fetch;

    await listAssistantBackups("my-assistant-id");

    expect(capturedUrl).toEndWith(
      "/v1/assistants/my-assistant-id/backups/",
    );
  });

  test("throws on network failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network failure");
    }) as unknown as typeof fetch;

    expect(() => listAssistantBackups("abc")).toThrow("network failure");
  });
});

describe("getAssistant", () => {
  function makeListResponse(status: string) {
    return {
      count: 1,
      results: [
        {
          id: "asst-1",
          status,
          created: "2024-01-01T00:00:00Z",
        },
      ],
    };
  }

  test("returns first result for active assistant", async () => {
    mockFetch(200, makeListResponse("active"));

    const result = await getAssistant();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("active");
    }
  });

  test("returns first result for initializing assistant", async () => {
    mockFetch(200, makeListResponse("initializing"));

    const result = await getAssistant();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("initializing");
    }
  });

  test("returns first result for to_be_deleted assistant", async () => {
    mockFetch(200, makeListResponse("to_be_deleted"));

    const result = await getAssistant();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("to_be_deleted");
    }
  });

  test("returns 404 result when results array is empty", async () => {
    mockFetch(200, { count: 0, results: [] });

    const result = await getAssistant();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  test("returns status-based error payload for 404", async () => {
    mockFetch(404, { detail: "Not found." });

    const result = await getAssistant();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toEqual({ detail: "Not found." });
    }
  });

  test("returns error payload for 500", async () => {
    mockFetch(500, { detail: "Internal server error" });

    const result = await getAssistant();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toEqual({ detail: "Internal server error" });
    }
  });
});

describe("hatchAssistant", () => {
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    // CSRF helpers access document.cookie — stub it for the test environment.
    originalDocument = globalThis.document;
    // @ts-expect-error - stub document for tests
    globalThis.document = { cookie: "" };
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  test("returns ok on successful hatch", async () => {
    mockFetch(200, {
      id: "asst-1",
      status: "initializing",
      created: "2024-01-01T00:00:00Z",
    });

    const result = await hatchAssistant();

    expect(result.ok).toBe(true);
  });

  test("returns error on failed hatch", async () => {
    mockFetch(400, { detail: "Hatch failed" });

    const result = await hatchAssistant();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});

describe("restoreAssistantBackup", () => {
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    // CSRF helpers access document.cookie — stub it for the test environment.
    originalDocument = globalThis.document;
    // @ts-expect-error - stub document for tests
    globalThis.document = { cookie: "" };
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  test("returns data on success", async () => {
    const restoreResult = {
      snapshot_name: BACKUP_A.snapshot_name,
      pvc: BACKUP_A.pvc,
      restored_at: "2024-01-03T09:00:00Z",
      was_awake: false,
    };
    mockFetch(200, restoreResult);

    const result = await restoreAssistantBackup("abc", BACKUP_A);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual(restoreResult);
    }
  });

  test("returns error on upstream failure", async () => {
    mockFetch(400, { detail: "snapshot not found" });

    const result = await restoreAssistantBackup("abc", BACKUP_A);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toEqual({ detail: "snapshot not found" });
    }
  });

  test("returns error on 502", async () => {
    mockFetch(502, { detail: "Bad gateway" });

    const result = await restoreAssistantBackup("abc", BACKUP_A);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
    }
  });

  test("calls correct URL with POST method", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = mock(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = getRequestUrl(url);
        if (url instanceof Request) {
          capturedMethod = url.method;
        } else {
          capturedMethod = init?.method ?? "GET";
        }
        return Response.json({});
      },
    ) as unknown as typeof fetch;

    await restoreAssistantBackup("my-assistant-id", BACKUP_A);

    expect(capturedUrl).toEndWith(
      `/v1/assistants/my-assistant-id/backups/${BACKUP_A.snapshot_name}/restore/`,
    );
    expect(capturedMethod).toBe("POST");
  });
});
