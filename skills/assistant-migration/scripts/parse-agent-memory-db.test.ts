import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractMemoryDb } from "./parse-agent-memory-db.js";
import type { MemoryImportItem } from "./lib/memory-items.js";

let fixtureDir: string;
let fixtureDbPath: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "parse-agent-memory-db-"));
  fixtureDbPath = join(fixtureDir, "memory.db");

  const db = new Database(fixtureDbPath, { create: true });
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY,
      content TEXT,
      created_at INTEGER
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      uuid TEXT,
      title TEXT,
      body TEXT,
      updated_at TEXT
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(content);
  `);
  db.exec(
    "INSERT INTO memories (content, created_at) VALUES " +
      "('User prefers tea over coffee', 1735689600), " +
      "('User works from a home office', NULL)",
  );
  db.exec(
    "INSERT INTO notes (uuid, title, body, updated_at) VALUES " +
      "('note-123', 'Project Atlas', 'Atlas launch is planned for spring', '2026-01-15T10:30:00Z')",
  );
  db.exec(
    "INSERT INTO memories_fts (content) VALUES ('User prefers tea over coffee')",
  );
  db.close();
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("extractMemoryDb", () => {
  test("extracts text-bearing columns as review candidates", () => {
    const { items } = extractMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).toContain("User prefers tea over coffee");
    expect(texts).toContain("User works from a home office");
    expect(texts).toContain("Project Atlas");
    expect(texts).toContain("Atlas launch is planned for spring");

    for (const item of items) {
      expect(item.source).toBe("import:hermes");
      expect(item.text.length).toBeGreaterThan(0);
    }
  });

  test("records context as table.column", () => {
    const { items } = extractMemoryDb(fixtureDbPath, "hermes");

    const memoryItem = items.find(
      (i) => i.text === "User prefers tea over coffee",
    );
    expect(memoryItem?.context).toBe("memories.content");

    const bodyItem = items.find(
      (i) => i.text === "Atlas launch is planned for spring",
    );
    expect(bodyItem?.context).toBe("notes.body");
  });

  test("skips FTS5 virtual and shadow tables", () => {
    const { items, census } = extractMemoryDb(fixtureDbPath, "hermes");

    for (const item of items) {
      expect(item.context?.startsWith("memories_fts")).toBe(false);
    }

    const ftsEntries = census.filter((c) => c.table.startsWith("memories_fts"));
    expect(ftsEntries.length).toBeGreaterThan(0);
    for (const entry of ftsEntries) {
      expect(entry.status).toBe("skipped");
    }

    const extractedTables = census
      .filter((c) => c.status === "extracted")
      .map((c) => c.table)
      .sort();
    expect(extractedTables).toEqual(["memories", "notes"]);
  });

  test("detects origin_date from epoch and ISO timestamp columns", () => {
    const { items } = extractMemoryDb(fixtureDbPath, "hermes");

    const epochItem = items.find(
      (i) => i.text === "User prefers tea over coffee",
    );
    expect(epochItem?.origin_date).toBe("2025-01-01T00:00:00.000Z");

    const isoItem = items.find(
      (i) => i.text === "Atlas launch is planned for spring",
    );
    expect(isoItem?.origin_date).toBe("2026-01-15T10:30:00.000Z");

    const undatedItem = items.find(
      (i) => i.text === "User works from a home office",
    );
    expect(undatedItem?.origin_date).toBeUndefined();
  });

  test("skips identifier-like and timestamp-like values", () => {
    const { items } = extractMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).not.toContain("note-123");
    expect(texts).not.toContain("2026-01-15T10:30:00Z");
  });

  test("tags items with the requested provider", () => {
    const { items } = extractMemoryDb(fixtureDbPath, "openclaw");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe("import:openclaw");
    }
  });
});

describe("CLI contract", () => {
  test("emits valid MemoryImportItem[] JSON on stdout", () => {
    const scriptPath = join(import.meta.dir, "parse-agent-memory-db.ts");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        scriptPath,
        "--file",
        fixtureDbPath,
        "--source",
        "hermes",
      ],
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.toString()) as MemoryImportItem[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const item of parsed) {
      expect(typeof item.text).toBe("string");
      expect(item.source).toBe("import:hermes");
    }

    const stderr = result.stderr.toString();
    expect(stderr).toContain("Table census:");
    expect(stderr).toContain("memories");
  });

  test("rejects an unsupported --source", () => {
    const scriptPath = join(import.meta.dir, "parse-agent-memory-db.ts");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        scriptPath,
        "--file",
        fixtureDbPath,
        "--source",
        "unknown-agent",
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unsupported --source");
  });
});
