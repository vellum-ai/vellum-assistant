import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractMemoryDb, isSecretName } from "./parse-agent-memory-db.js";
import {
  createItemsJsonStreamWriter,
  type MemoryImportItem,
} from "./lib/memory-items.js";

/**
 * Test helper: run the streaming extractor and collect the emitted items,
 * since production callers stream them instead of accumulating.
 */
function collectMemoryDb(
  dbPath: string,
  provider: Parameters<typeof extractMemoryDb>[1],
): {
  items: MemoryImportItem[];
  census: ReturnType<typeof extractMemoryDb>["census"];
} {
  const items: MemoryImportItem[] = [];
  const { census } = extractMemoryDb(dbPath, provider, (item) =>
    items.push(item),
  );
  return { items, census };
}

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
      author TEXT,
      api_key TEXT,
      updated_at TEXT
    );
    CREATE TABLE oauth_tokens (
      id INTEGER PRIMARY KEY,
      provider TEXT,
      access_token TEXT
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(content);
  `);
  db.exec(
    "INSERT INTO memories (content, created_at) VALUES " +
      "('User prefers tea over coffee', 1735689600), " +
      "('User works from a home office', NULL)",
  );
  db.exec(
    "INSERT INTO notes (uuid, title, body, author, api_key, updated_at) VALUES " +
      "('note-123', 'Project Atlas', 'Atlas launch is planned for spring', 'Casey the author', 'sk-FAKE-EXAMPLE-column', '2026-01-15T10:30:00Z')",
  );
  db.exec(
    "INSERT INTO oauth_tokens (provider, access_token) VALUES " +
      "('example-provider', 'sk-FAKE-EXAMPLE-table')",
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
    const { items } = collectMemoryDb(fixtureDbPath, "hermes");

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
    const { items } = collectMemoryDb(fixtureDbPath, "hermes");

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
    const { items, census } = collectMemoryDb(fixtureDbPath, "hermes");

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
    const { items } = collectMemoryDb(fixtureDbPath, "hermes");

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
    const { items } = collectMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).not.toContain("note-123");
    expect(texts).not.toContain("2026-01-15T10:30:00Z");
  });

  test("tags items with the requested provider", () => {
    const { items } = collectMemoryDb(fixtureDbPath, "openclaw");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe("import:openclaw");
    }
  });

  test("excludes credential-like tables and reports them as skipped", () => {
    const { items, census } = collectMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).not.toContain("sk-FAKE-EXAMPLE-table");
    expect(texts).not.toContain("example-provider");
    for (const item of items) {
      expect(item.context?.startsWith("oauth_tokens")).toBe(false);
    }

    const entry = census.find((c) => c.table === "oauth_tokens");
    expect(entry?.status).toBe("skipped");
    expect(entry?.reason).toContain("credential-like table name");
  });

  test("excludes credential-like columns and reports them in the census", () => {
    const { items, census } = collectMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).not.toContain("sk-FAKE-EXAMPLE-column");
    for (const item of items) {
      expect(item.context).not.toBe("notes.api_key");
    }

    const entry = census.find((c) => c.table === "notes");
    expect(entry?.status).toBe("extracted");
    expect(entry?.secretColumns).toEqual(["api_key"]);
  });

  test("does not flag benign names that merely contain secret substrings", () => {
    const { items } = collectMemoryDb(fixtureDbPath, "hermes");

    const texts = items.map((i) => i.text);
    expect(texts).toContain("Casey the author");
  });

  test("extracts every row from tables larger than one batch", () => {
    const bigDbPath = join(fixtureDir, "big-memory.db");
    const db = new Database(bigDbPath, { create: true });
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)");
    const insert = db.query("INSERT INTO memories (content) VALUES (?)");
    const total = 2500;
    for (let i = 0; i < total; i++) {
      insert.run(`Fact number ${i}`);
    }
    db.close();

    const { items, census } = collectMemoryDb(bigDbPath, "hermes");
    expect(items.length).toBe(total);
    const entry = census.find((c) => c.table === "memories");
    expect(entry?.rows).toBe(total);
    expect(entry?.items).toBe(total);

    const texts = new Set(items.map((i) => i.text));
    expect(texts.size).toBe(total);
    expect(texts.has("Fact number 0")).toBe(true);
    expect(texts.has(`Fact number ${total - 1}`)).toBe(true);
  });
});

describe("createItemsJsonStreamWriter", () => {
  test("streams the same bytes as a whole-array stringify", () => {
    const items: MemoryImportItem[] = [
      { text: "First", source: "import:hermes", context: "memories.content" },
      {
        text: "Second",
        source: "import:hermes",
        origin_date: "2025-01-01T00:00:00.000Z",
      },
    ];

    let streamed = "";
    const writer = createItemsJsonStreamWriter((chunk) => {
      streamed += chunk;
    });
    for (const item of items) {
      writer.writeItem(item);
    }
    writer.end();

    expect(streamed).toBe(JSON.stringify(items, null, 2) + "\n");
    expect(JSON.parse(streamed)).toEqual(items);
  });

  test("emits an empty JSON array when no items are written", () => {
    let streamed = "";
    const writer = createItemsJsonStreamWriter((chunk) => {
      streamed += chunk;
    });
    writer.end();

    expect(JSON.parse(streamed)).toEqual([]);
  });
});

describe("isSecretName", () => {
  test("matches credential-like names across naming conventions", () => {
    for (const name of [
      "access_token",
      "api_key",
      "api_keys",
      "oauth_tokens",
      "apiKey",
      "PASSWORD",
      "passwd",
      "client_secret",
      "credentials",
      "cookie_jar",
      "session_state",
      "auth_header",
      "bearer_value",
      "private_key",
      "privateKey",
      "refresh_expiry",
      "oauth_state",
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
  });

  test("matches access-key names despite the trailing ss", () => {
    for (const name of [
      "accessKey",
      "access_key",
      "access_keys",
      "ACCESS_KEY",
      "accessKeyId",
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
  });

  test("does not match benign names", () => {
    for (const name of [
      "author",
      "authored_by",
      "content",
      "keyboard",
      "monkeys",
      "credo",
      "sessional_notes",
      "title",
      "compass",
      "address",
      "compass_heading",
      "home_address",
    ]) {
      expect(isSecretName(name)).toBe(false);
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

  test("streams every row of a multi-batch table as parseable JSON", () => {
    const bigDbPath = join(fixtureDir, "big-cli-memory.db");
    const db = new Database(bigDbPath, { create: true });
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)");
    const insert = db.query("INSERT INTO memories (content) VALUES (?)");
    const total = 2500;
    for (let i = 0; i < total; i++) {
      insert.run(`Fact number ${i}`);
    }
    db.close();

    const scriptPath = join(import.meta.dir, "parse-agent-memory-db.ts");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        scriptPath,
        "--file",
        bigDbPath,
        "--source",
        "hermes",
      ],
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.toString()) as MemoryImportItem[];
    expect(parsed.length).toBe(total);
    const texts = new Set(parsed.map((i) => i.text));
    expect(texts.size).toBe(total);
    expect(texts.has("Fact number 0")).toBe(true);
    expect(texts.has(`Fact number ${total - 1}`)).toBe(true);

    expect(result.stderr.toString()).toContain(
      `Total: ${total} review candidates`,
    );
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
