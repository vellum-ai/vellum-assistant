import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { getDataDir, getDbPath } from "../../util/platform.js";
import { getTrackedDataFiles, parseFincoreJson } from "../page-cache.js";

describe("parseFincoreJson", () => {
  test("parses numeric and string-numeric fincore output", () => {
    const stdout = JSON.stringify({
      fincore: [
        {
          res: 1363148800,
          pages: 332800,
          size: 2147483648,
          file: "/workspace/data/db/assistant.db",
        },
        {
          res: "4096",
          pages: "1",
          size: "8192",
          file: "/workspace/data/db/assistant.db-wal",
        },
      ],
    });

    expect(parseFincoreJson(stdout)).toEqual([
      {
        path: "/workspace/data/db/assistant.db",
        sizeBytes: 2147483648,
        residentBytes: 1363148800,
        residentRatio: 1363148800 / 2147483648,
      },
      {
        path: "/workspace/data/db/assistant.db-wal",
        sizeBytes: 8192,
        residentBytes: 4096,
        residentRatio: 0.5,
      },
    ]);
  });

  test("empty file yields a null ratio", () => {
    const rows = parseFincoreJson(
      JSON.stringify({ fincore: [{ res: 0, size: 0, file: "/tmp/empty" }] }),
    );
    expect(rows[0].residentRatio).toBeNull();
  });

  test("tolerates malformed output", () => {
    expect(parseFincoreJson("")).toEqual([]);
    expect(parseFincoreJson("not json")).toEqual([]);
    expect(parseFincoreJson(JSON.stringify({ fincore: "nope" }))).toEqual([]);
    expect(
      parseFincoreJson(JSON.stringify({ fincore: [{ file: 42, res: "x" }] })),
    ).toEqual([]);
  });
});

describe("getTrackedDataFiles", () => {
  test("returns existing db sidecars and the largest qdrant files", () => {
    const dbPath = getDbPath();
    mkdirSync(join(getDataDir(), "db"), { recursive: true });
    writeFileSync(dbPath, "x".repeat(64));
    writeFileSync(`${dbPath}-wal`, "x".repeat(32));

    const segments = join(getDataDir(), "qdrant", "collections", "c1");
    mkdirSync(segments, { recursive: true });
    writeFileSync(join(segments, "big.seg"), "x".repeat(100));
    writeFileSync(join(segments, "small.seg"), "x".repeat(10));

    // Containment assertions: other suites sharing this process's workspace
    // may create the -shm sidecar, so the exact list is not deterministic.
    const tracked = getTrackedDataFiles(1);

    expect(tracked).toContain(dbPath);
    expect(tracked).toContain(`${dbPath}-wal`);
    expect(tracked).toContain(join(segments, "big.seg"));
    // The qdrant limit of 1 keeps the smaller segment out.
    expect(tracked).not.toContain(join(segments, "small.seg"));
  });
});
