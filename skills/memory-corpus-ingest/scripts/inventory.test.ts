import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildInventory,
  dateFromFilename,
  suggestSlices,
  walkFiles,
  type FileInfo,
} from "./inventory.ts";

let root: string;

function writeFixture(relPath: string, content: string, mtime?: Date): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  if (mtime) {
    utimesSync(full, mtime, mtime);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "corpus-inventory-"));
  // Dated filenames across two quarters
  writeFixture("2025-01/2025-01-09 acme sync.vtt", "WEBVTT\n\nhello");
  writeFixture("2025-01/2025-01-09 acme sync.md", "# summary");
  writeFixture("2025-02/2025_02_20 northwind.vtt", "WEBVTT\n\nworld");
  writeFixture("2025-04/20250402-planning.txt", "notes");
  // Undated file: date should come from mtime
  writeFixture(
    "misc/undated-notes.txt",
    "no date here",
    new Date("2025-03-15T12:00:00Z"),
  );
  // Hidden entries must be skipped
  writeFixture(".staging/should-not-count.md", "staged page");
  writeFixture("2025-01/.hidden-file.md", "hidden");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dateFromFilename", () => {
  test("recognizes dashed, underscored, and compact dates", () => {
    expect(dateFromFilename("2025-01-09 acme sync.vtt")).toBe("2025-01-09");
    expect(dateFromFilename("2025_02_20 northwind.vtt")).toBe("2025-02-20");
    expect(dateFromFilename("20250402-planning.txt")).toBe("2025-04-02");
  });

  test("rejects implausible dates and plain numbers", () => {
    expect(dateFromFilename("2025-13-40 broken.txt")).toBeNull();
    expect(dateFromFilename("release-1.2.3.txt")).toBeNull();
    expect(dateFromFilename("undated-notes.txt")).toBeNull();
  });

  test("rejects syntactically shaped but impossible calendar dates", () => {
    expect(dateFromFilename("2025-02-29 standup.vtt")).toBeNull();
    expect(dateFromFilename("2025-04-31 retro.vtt")).toBeNull();
    expect(dateFromFilename("2024-02-29 leap-day.vtt")).toBe("2024-02-29");
  });
});

describe("walkFiles", () => {
  test("censuses files, skips dot-entries, and sorts by date", () => {
    const files = walkFiles(root);
    expect(files.length).toBe(5);
    expect(files.some((f) => f.path.includes(".staging"))).toBe(false);
    expect(files.some((f) => f.path.includes(".hidden-file"))).toBe(false);
    const dates = files.map((f) => f.date);
    expect(dates).toEqual([...dates].sort());
  });

  test("prefers filename dates and falls back to mtime", () => {
    const files = walkFiles(root);
    const dated = files.find((f) => f.path.endsWith("acme sync.vtt"));
    expect(dated?.date).toBe("2025-01-09");
    expect(dated?.dateFromName).toBe(true);
    const undated = files.find((f) => f.path.endsWith("undated-notes.txt"));
    expect(undated?.date).toBe("2025-03-15");
    expect(undated?.dateFromName).toBe(false);
  });
});

describe("buildInventory", () => {
  test("reports counts, sizes, extensions, and date range", () => {
    const inventory = buildInventory(root);
    expect(inventory.files).toBe(5);
    expect(inventory.totalBytes).toBeGreaterThan(0);
    expect(inventory.byExtension[".vtt"]).toBe(2);
    expect(inventory.byExtension[".md"]).toBe(1);
    expect(inventory.byExtension[".txt"]).toBe(2);
    expect(inventory.dateRange).toEqual({
      earliest: "2025-01-09",
      latest: "2025-04-02",
    });
  });

  test("suggests monthly slices when they fit the budget", () => {
    const inventory = buildInventory(root);
    const labels = inventory.suggestedSlices.map((s) => s.label);
    expect(labels).toEqual(["2025-01", "2025-02", "2025-03", "2025-04"]);
    const january = inventory.suggestedSlices[0];
    expect(january.fileCount).toBe(2);
    expect(january.paths.every((p) => p.startsWith("2025-01/"))).toBe(true);
  });

  test("returns an empty plan for an empty directory", () => {
    const empty = mkdtempSync(join(tmpdir(), "corpus-empty-"));
    try {
      const inventory = buildInventory(empty);
      expect(inventory.files).toBe(0);
      expect(inventory.dateRange).toBeNull();
      expect(inventory.suggestedSlices).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("suggestSlices", () => {
  const fileOn = (date: string, name: string): FileInfo => ({
    path: name,
    bytes: 10,
    date,
    dateFromName: true,
  });

  test("coarsens month groups to quarters when over the slice budget", () => {
    const files = [
      fileOn("2025-01-05", "a.txt"),
      fileOn("2025-02-05", "b.txt"),
      fileOn("2025-03-05", "c.txt"),
      fileOn("2025-04-05", "d.txt"),
    ];
    const slices = suggestSlices(files, { maxSlices: 2 });
    expect(slices.map((s) => s.label)).toEqual(["2025-Q1", "2025-Q2"]);
    expect(slices[0].fileCount).toBe(3);
    expect(slices[0].earliest).toBe("2025-01-05");
    expect(slices[0].latest).toBe("2025-03-05");
  });

  test("coarsens to years when quarters still exceed the budget", () => {
    const files = [
      fileOn("2024-01-05", "a.txt"),
      fileOn("2024-07-05", "b.txt"),
      fileOn("2025-02-05", "c.txt"),
      fileOn("2025-11-05", "d.txt"),
    ];
    const slices = suggestSlices(files, { maxSlices: 2 });
    expect(slices.map((s) => s.label)).toEqual(["2024", "2025"]);
  });

  test("splits oversize buckets into parts", () => {
    const files = [
      fileOn("2025-01-01", "a.txt"),
      fileOn("2025-01-02", "b.txt"),
      fileOn("2025-01-03", "c.txt"),
      fileOn("2025-01-04", "d.txt"),
      fileOn("2025-01-05", "e.txt"),
    ];
    const slices = suggestSlices(files, { maxFilesPerSlice: 2 });
    expect(slices.map((s) => s.label)).toEqual([
      "2025-01 (part 1)",
      "2025-01 (part 2)",
      "2025-01 (part 3)",
    ]);
    expect(slices.reduce((sum, s) => sum + s.fileCount, 0)).toBe(5);
    expect(slices[0].paths).toEqual(["a.txt", "b.txt"]);
  });
});
