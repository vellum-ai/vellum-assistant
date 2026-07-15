import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createKeyedStorageAccessor,
  createRecordStorageAccessor,
  createStorageAccessor,
  parseBool,
} from "./typed-storage";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// createStorageAccessor
// ---------------------------------------------------------------------------

describe("createStorageAccessor", () => {
  const accessor = createStorageAccessor<string[]>({
    key: "vellum:test-items",
    scope: "user",
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    },
    serialize: JSON.stringify,
    fallback: [],
  });

  test("load returns fallback when key is absent", () => {
    expect(accessor.load()).toEqual([]);
  });

  test("save writes and load reads back", () => {
    accessor.save(["a", "b"]);
    expect(accessor.load()).toEqual(["a", "b"]);
    expect(localStorage.getItem("vellum:test-items")).toBe('["a","b"]');
  });

  test("remove deletes the key", () => {
    accessor.save(["a"]);
    accessor.remove();
    expect(accessor.load()).toEqual([]);
    expect(localStorage.getItem("vellum:test-items")).toBeNull();
  });

  test("load returns fallback on corrupted data", () => {
    localStorage.setItem("vellum:test-items", "not-json");
    expect(accessor.load()).toEqual([]);
  });

  test("load returns fallback when parse returns null", () => {
    localStorage.setItem("vellum:test-items", '"a string"');
    expect(accessor.load()).toEqual([]);
  });

  test("returns same reference when raw value unchanged (snapshot stability)", () => {
    accessor.save(["x", "y"]);
    const first = accessor.load();
    const second = accessor.load();
    expect(first).toBe(second);
  });

  test("returns new reference after value changes", () => {
    accessor.save(["x"]);
    const first = accessor.load();
    accessor.save(["x", "y"]);
    const second = accessor.load();
    expect(first).not.toBe(second);
    expect(second).toEqual(["x", "y"]);
  });

  test("exposes key and scope", () => {
    expect(accessor.key).toBe("vellum:test-items");
    expect(accessor.scope).toBe("user");
  });

  describe("boolean accessor", () => {
    const boolAccessor = createStorageAccessor<boolean>({
      key: "vellum:test-flag",
      scope: "user",
      parse: parseBool,
      serialize: (v) => String(v),
      fallback: false,
    });

    test("reads and writes booleans", () => {
      boolAccessor.save(true);
      expect(boolAccessor.load()).toBe(true);

      boolAccessor.save(false);
      expect(boolAccessor.load()).toBe(false);
    });

    test("returns fallback on non-boolean string", () => {
      localStorage.setItem("vellum:test-flag", "maybe");
      expect(boolAccessor.load()).toBe(false);
    });
  });

  describe("number accessor", () => {
    const numAccessor = createStorageAccessor<number>({
      key: "vellum:test-width",
      scope: "device",
      parse: (raw) => {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      },
      serialize: String,
      fallback: 300,
    });

    test("reads and writes numbers", () => {
      numAccessor.save(420);
      expect(numAccessor.load()).toBe(420);
    });

    test("returns fallback on NaN", () => {
      localStorage.setItem("vellum:test-width", "abc");
      expect(numAccessor.load()).toBe(300);
    });

    test("scope is device", () => {
      expect(numAccessor.scope).toBe("device");
    });
  });
});

// ---------------------------------------------------------------------------
// createKeyedStorageAccessor
// ---------------------------------------------------------------------------

describe("createKeyedStorageAccessor", () => {
  const keyed = createKeyedStorageAccessor<string>({
    keyFn: (id) => `vellum:lastConvo:${id}`,
    scope: "user",
    parse: (raw) => (raw.length > 0 ? raw : null),
    serialize: (v) => v,
    fallback: "",
  });

  test("stores and retrieves per-entity values", () => {
    keyed.save("asst-1", "conv-abc");
    keyed.save("asst-2", "conv-xyz");

    expect(keyed.load("asst-1")).toBe("conv-abc");
    expect(keyed.load("asst-2")).toBe("conv-xyz");
    expect(keyed.load("asst-3")).toBe("");
  });

  test("remove deletes per-entity key", () => {
    keyed.save("asst-1", "conv-abc");
    keyed.remove("asst-1");
    expect(keyed.load("asst-1")).toBe("");
  });

  test("exposes keyFn and scope", () => {
    expect(keyed.keyFn("asst-1")).toBe("vellum:lastConvo:asst-1");
    expect(keyed.scope).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// createRecordStorageAccessor
// ---------------------------------------------------------------------------

describe("createRecordStorageAccessor", () => {
  interface TestEntry {
    value: number;
    label: string;
  }

  function parseEntry(raw: unknown): TestEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.value !== "number" || typeof r.label !== "string") return null;
    return { value: r.value as number, label: r.label as string };
  }

  const record = createRecordStorageAccessor<TestEntry>({
    keyFn: (id) => `vellum:test-record:${id}`,
    scope: "user",
    parseValue: parseEntry,
    fallback: {},
    maxEntries: 3,
  });

  test("load returns empty record when absent", () => {
    expect(record.load("entity-1")).toEqual({});
  });

  test("set and get individual entries", () => {
    record.set("entity-1", "key-a", { value: 1, label: "A" });
    record.set("entity-1", "key-b", { value: 2, label: "B" });

    expect(record.get("entity-1", "key-a")).toEqual({ value: 1, label: "A" });
    expect(record.get("entity-1", "key-b")).toEqual({ value: 2, label: "B" });
    expect(record.get("entity-1", "key-c")).toBeUndefined();
  });

  test("entities are independent", () => {
    record.set("entity-1", "key-a", { value: 1, label: "A" });
    record.set("entity-2", "key-a", { value: 99, label: "Z" });

    expect(record.get("entity-1", "key-a")?.value).toBe(1);
    expect(record.get("entity-2", "key-a")?.value).toBe(99);
  });

  test("trims oldest entries when exceeding maxEntries", () => {
    record.set("entity-1", "k1", { value: 1, label: "first" });
    record.set("entity-1", "k2", { value: 2, label: "second" });
    record.set("entity-1", "k3", { value: 3, label: "third" });
    record.set("entity-1", "k4", { value: 4, label: "fourth" });

    const data = record.load("entity-1");
    const keys = Object.keys(data);
    expect(keys.length).toBe(3);
    expect(data.k1).toBeUndefined();
    expect(data.k2).toEqual({ value: 2, label: "second" });
    expect(data.k4).toEqual({ value: 4, label: "fourth" });
  });

  test("deleteEntry removes a single entry", () => {
    record.set("entity-1", "key-a", { value: 1, label: "A" });
    record.set("entity-1", "key-b", { value: 2, label: "B" });
    record.deleteEntry("entity-1", "key-a");

    expect(record.get("entity-1", "key-a")).toBeUndefined();
    expect(record.get("entity-1", "key-b")).toEqual({ value: 2, label: "B" });
  });

  test("remove deletes the entire record", () => {
    record.set("entity-1", "key-a", { value: 1, label: "A" });
    record.remove("entity-1");
    expect(record.load("entity-1")).toEqual({});
  });

  test("load filters out invalid entries", () => {
    localStorage.setItem(
      "vellum:test-record:entity-1",
      JSON.stringify({
        good: { value: 1, label: "ok" },
        bad: { value: "not-a-number", label: "fail" },
        ugly: "not-an-object",
      }),
    );

    const data = record.load("entity-1");
    expect(Object.keys(data)).toEqual(["good"]);
    expect(data.good).toEqual({ value: 1, label: "ok" });
  });

  test("load returns fallback on corrupted JSON", () => {
    localStorage.setItem("vellum:test-record:entity-1", "{{broken");
    expect(record.load("entity-1")).toEqual({});
  });

  test("load returns fallback on non-object JSON", () => {
    localStorage.setItem("vellum:test-record:entity-1", "[1,2,3]");
    expect(record.load("entity-1")).toEqual({});
  });

  describe("without maxEntries", () => {
    const unbounded = createRecordStorageAccessor<TestEntry>({
      keyFn: (id) => `vellum:unbounded:${id}`,
      scope: "user",
      parseValue: parseEntry,
      fallback: {},
    });

    test("does not trim entries", () => {
      for (let i = 0; i < 10; i++) {
        unbounded.set("entity-1", `k${i}`, { value: i, label: `item-${i}` });
      }
      expect(Object.keys(unbounded.load("entity-1")).length).toBe(10);
    });
  });
});
