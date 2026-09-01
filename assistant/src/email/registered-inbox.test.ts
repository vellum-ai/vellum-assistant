/**
 * Tests for the shared registered-inbox reader: the single answer to "does
 * this assistant have a managed inbox?", read from the platform
 * email-addresses API (the only writer of managed registrations).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks, set up before importing the module under test
// ---------------------------------------------------------------------------

let mockPlatformAssistantId: string | null;
let mockResponse: { ok: boolean; status: number; body: unknown };
let mockFetchThrows: boolean;
let mockCreateThrows: boolean;
let fetchCallCount: number;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => {
      if (mockCreateThrows) {
        throw new Error("credential store unavailable");
      }
      return clientStub();
    },
  },
}));

const clientStub = () => ({
  platformAssistantId: mockPlatformAssistantId,
  fetch: async (_path: string) => {
    fetchCallCount += 1;
    if (mockFetchThrows) {
      throw new Error("platform unreachable");
    }
    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      json: async () => mockResponse.body,
    };
  },
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { VellumPlatformClient } from "../platform/client.js";
import {
  invalidateRegisteredInboxCache,
  listEmailAddresses,
  resolveRegisteredInbox,
} from "./registered-inbox.js";

async function testClient(): Promise<VellumPlatformClient> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new Error("mocked create returned null");
  }
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRegisteredInbox", () => {
  beforeEach(() => {
    mockPlatformAssistantId = "assistant-test-id";
    mockResponse = { ok: true, status: 200, body: { count: 0, results: [] } };
    mockFetchThrows = false;
    mockCreateThrows = false;
    fetchCallCount = 0;
    invalidateRegisteredInboxCache();
  });

  test("unavailable when client creation itself throws", async () => {
    mockCreateThrows = true;

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({
      status: "unavailable",
      detail: "credential store unavailable",
    });
  });

  test("registered when the platform lists an address", async () => {
    mockResponse = {
      ok: true,
      status: 200,
      body: {
        count: 1,
        results: [{ id: "addr-1", address: "assistant@example.com" }],
      },
    };

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({
      status: "registered",
      address: "assistant@example.com",
    });
  });

  test("none when the platform lists no addresses", async () => {
    const state = await resolveRegisteredInbox();

    expect(state).toEqual({ status: "none" });
  });

  test("no_platform when platform credentials are missing", async () => {
    mockPlatformAssistantId = null;

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({ status: "no_platform" });
  });

  test("unavailable on a non-ok platform response", async () => {
    mockResponse = { ok: false, status: 503, body: { detail: "boom" } };

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({ status: "unavailable", detail: "HTTP 503" });
  });

  test("unavailable when the platform fetch throws", async () => {
    mockFetchThrows = true;

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({
      status: "unavailable",
      detail: "platform unreachable",
    });
  });

  test("unavailable on an unexpected response shape", async () => {
    mockResponse = { ok: true, status: 200, body: { results: "not-a-list" } };

    const state = await resolveRegisteredInbox();

    expect(state).toEqual({
      status: "unavailable",
      detail: "unexpected response shape",
    });
  });

  test("serves the cached answer within the TTL", async () => {
    mockResponse = {
      ok: true,
      status: 200,
      body: { count: 1, results: [{ id: "addr-1", address: "hi@bot" }] },
    };
    await resolveRegisteredInbox();

    // A changed platform answer is not observed until the cache is dropped.
    mockResponse = { ok: true, status: 200, body: { count: 0, results: [] } };
    const state = await resolveRegisteredInbox();

    expect(state).toEqual({ status: "registered", address: "hi@bot" });
    expect(fetchCallCount).toBe(1);
  });

  test("fresh bypasses the cache and updates it", async () => {
    await resolveRegisteredInbox();
    mockResponse = {
      ok: true,
      status: 200,
      body: { count: 1, results: [{ id: "addr-1", address: "hi@bot" }] },
    };

    const fresh = await resolveRegisteredInbox({ fresh: true });
    const cached = await resolveRegisteredInbox();

    expect(fresh).toEqual({ status: "registered", address: "hi@bot" });
    expect(cached).toEqual({ status: "registered", address: "hi@bot" });
    expect(fetchCallCount).toBe(2);
  });

  test("invalidate drops the cached answer", async () => {
    await resolveRegisteredInbox();
    invalidateRegisteredInboxCache();
    await resolveRegisteredInbox();

    expect(fetchCallCount).toBe(2);
  });

  test("unavailable is not cached, so the next call retries", async () => {
    mockFetchThrows = true;
    await resolveRegisteredInbox();

    mockFetchThrows = false;
    mockResponse = {
      ok: true,
      status: 200,
      body: { count: 1, results: [{ id: "addr-1", address: "hi@bot" }] },
    };
    const state = await resolveRegisteredInbox();

    expect(state).toEqual({ status: "registered", address: "hi@bot" });
  });
});

describe("listEmailAddresses", () => {
  beforeEach(() => {
    mockPlatformAssistantId = "assistant-test-id";
    mockResponse = { ok: true, status: 200, body: { count: 0, results: [] } };
    mockFetchThrows = false;
    mockCreateThrows = false;
    fetchCallCount = 0;
  });

  test("a 200 without results is a failed listing, not an empty one", async () => {
    mockResponse = { ok: true, status: 200, body: {} };

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({ ok: false, detail: "unexpected response shape" });
  });

  test("a positive count with no rows is a failed listing", async () => {
    mockResponse = { ok: true, status: 200, body: { count: 2, results: [] } };

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({
      ok: false,
      detail: "listing reported 2 addresses but returned none",
    });
  });

  test("returns the platform's rows with ids", async () => {
    mockResponse = {
      ok: true,
      status: 200,
      body: { results: [{ id: "addr-1", address: "user@example.com" }] },
    };

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({
      ok: true,
      addresses: [{ id: "addr-1", address: "user@example.com" }],
    });
  });

  test("carries the platform's status on a non-ok response", async () => {
    mockResponse = { ok: false, status: 503, body: { detail: "boom" } };

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({ ok: false, status: 503, detail: "HTTP 503" });
  });

  test("fails without a status when the fetch throws", async () => {
    mockFetchThrows = true;

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({ ok: false, detail: "platform unreachable" });
  });

  test("fails on an unexpected response shape", async () => {
    mockResponse = { ok: true, status: 200, body: { results: [{ id: 7 }] } };

    const list = await listEmailAddresses(await testClient());

    expect(list).toEqual({ ok: false, detail: "unexpected response shape" });
  });
});
