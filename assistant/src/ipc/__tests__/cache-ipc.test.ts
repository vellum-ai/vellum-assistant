/**
 * Integration tests for the cache IPC routes.
 *
 * Exercises the full IPC round-trip: AssistantIpcServer + cliIpcCall over
 * the Unix domain socket, with the real in-memory cache store backing
 * the route handlers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearCacheForTests } from "../../skills/skill-cache-store.js";
import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCall } from "../cli-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: AssistantIpcServer | null = null;

beforeEach(async () => {
  clearCacheForTests();
  server = new AssistantIpcServer();
  await server.start();
  // Allow the server socket to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(() => {
  server?.stop();
  server = null;
  clearCacheForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cache IPC routes", () => {
  // ── Set / Get round-trip ──────────────────────────────────────────

  test("set then get returns stored data", async () => {
    const setResult = await cliIpcCall<{ key: string }>("cache/set", {
      data: { greeting: "hello" },
    });

    expect(setResult.ok).toBe(true);
    expect(setResult.result).toBeDefined();
    const key = setResult.result!.key;
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);

    const getResult = await cliIpcCall<{ data: unknown }>("cache/get", {
      key,
    });

    expect(getResult.ok).toBe(true);
    expect(getResult.result).toEqual({ data: { greeting: "hello" } });
  });

  // ── Explicit key upsert ───────────────────────────────────────────

  test("set with explicit key upserts on second call", async () => {
    const set1 = await cliIpcCall<{ key: string }>("cache/set", {
      data: "first",
      key: "my-key",
    });
    expect(set1.ok).toBe(true);
    expect(set1.result!.key).toBe("my-key");

    const set2 = await cliIpcCall<{ key: string }>("cache/set", {
      data: "second",
      key: "my-key",
    });
    expect(set2.ok).toBe(true);
    expect(set2.result!.key).toBe("my-key");

    const getResult = await cliIpcCall<{ data: unknown }>("cache/get", {
      key: "my-key",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toEqual({ data: "second" });
  });

  // ── Delete ────────────────────────────────────────────────────────

  test("delete returns deleted: true and makes later get return null", async () => {
    // Store an entry first.
    const setResult = await cliIpcCall<{ key: string }>("cache/set", {
      data: 42,
      key: "to-delete",
    });
    expect(setResult.ok).toBe(true);

    // Delete it.
    const delResult = await cliIpcCall<{ deleted: boolean }>("cache/delete", {
      key: "to-delete",
    });
    expect(delResult.ok).toBe(true);
    expect(delResult.result).toEqual({ deleted: true });

    // Get should now return null.
    const getResult = await cliIpcCall<null>("cache/get", {
      key: "to-delete",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toBeNull();
  });

  test("delete on non-existent key returns deleted: false", async () => {
    const delResult = await cliIpcCall<{ deleted: boolean }>("cache/delete", {
      key: "never-existed",
    });
    expect(delResult.ok).toBe(true);
    expect(delResult.result).toEqual({ deleted: false });
  });

  // ── Get for non-existent key returns null ─────────────────────────

  test("get for non-existent key returns null", async () => {
    const getResult = await cliIpcCall<null>("cache/get", {
      key: "does-not-exist",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toBeNull();
  });

  // ── Validation errors ─────────────────────────────────────────────

  test("cache/set rejects missing data field", async () => {
    const result = await cliIpcCall("cache/set", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("data is required");
  });

  test("cache/set rejects empty key", async () => {
    const result = await cliIpcCall("cache/set", {
      data: "value",
      key: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/set rejects non-positive ttl_ms", async () => {
    const result = await cliIpcCall("cache/set", {
      data: "value",
      ttl_ms: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/set rejects negative ttl_ms", async () => {
    const result = await cliIpcCall("cache/set", {
      data: "value",
      ttl_ms: -100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/set rejects non-integer ttl_ms", async () => {
    const result = await cliIpcCall("cache/set", {
      data: "value",
      ttl_ms: 1.5,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/get rejects empty key", async () => {
    const result = await cliIpcCall("cache/get", { key: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/get rejects missing key", async () => {
    const result = await cliIpcCall("cache/get", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("cache/delete rejects empty key", async () => {
    const result = await cliIpcCall("cache/delete", { key: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Method aliases ────────────────────────────────────────────────

  test("cache_set alias works identically to cache/set", async () => {
    const setResult = await cliIpcCall<{ key: string }>("cache_set", {
      data: { alias: true },
      key: "alias-test",
    });
    expect(setResult.ok).toBe(true);
    expect(setResult.result!.key).toBe("alias-test");

    // Retrieve via the canonical method to confirm storage.
    const getResult = await cliIpcCall<{ data: unknown }>("cache/get", {
      key: "alias-test",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toEqual({ data: { alias: true } });
  });

  test("cache_get alias works identically to cache/get", async () => {
    await cliIpcCall("cache/set", { data: "via-canonical", key: "cg-alias" });

    const getResult = await cliIpcCall<{ data: unknown }>("cache_get", {
      key: "cg-alias",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toEqual({ data: "via-canonical" });
  });

  test("cache_delete alias works identically to cache/delete", async () => {
    await cliIpcCall("cache/set", { data: "to-remove", key: "cd-alias" });

    const delResult = await cliIpcCall<{ deleted: boolean }>("cache_delete", {
      key: "cd-alias",
    });
    expect(delResult.ok).toBe(true);
    expect(delResult.result).toEqual({ deleted: true });

    const getResult = await cliIpcCall<null>("cache/get", { key: "cd-alias" });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toBeNull();
  });

  // ── Structured payloads ───────────────────────────────────────────

  test("supports nested structured data payloads", async () => {
    const payload = {
      results: [
        { id: 1, name: "a", tags: ["x", "y"] },
        { id: 2, name: "b", tags: [] },
      ],
      meta: { total: 2, page: 1 },
    };

    const setResult = await cliIpcCall<{ key: string }>("cache/set", {
      data: payload,
      key: "structured",
    });
    expect(setResult.ok).toBe(true);

    const getResult = await cliIpcCall<{ data: unknown }>("cache/get", {
      key: "structured",
    });
    expect(getResult.ok).toBe(true);
    expect(getResult.result).toEqual({ data: payload });
  });

  // ── TTL parameter accepted ────────────────────────────────────────

  test("set with valid ttl_ms succeeds", async () => {
    const result = await cliIpcCall<{ key: string }>("cache/set", {
      data: "ephemeral",
      ttl_ms: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.result!.key).toBeDefined();
  });
});
