import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createInMemoryTrajectoryReader,
  openTrajectories,
  type IndexFile,
} from "../trajectory-reader";

const INDEX_FILENAME = "trajectories.index.json";
const JSONL_FILENAME = "trajectories.jsonl";

async function makeFixture(
  rows: Array<Record<string, unknown>>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
  await writeFile(
    join(dir, JSONL_FILENAME),
    rows.map((r) => JSON.stringify(r)).join("\n"),
    "utf8",
  );
  return dir;
}

async function readIndex(dir: string): Promise<IndexFile> {
  return JSON.parse(
    await readFile(join(dir, INDEX_FILENAME), "utf8"),
  ) as IndexFile;
}

describe("openTrajectories — index build", () => {
  test("builds an index on first open and writes it next to the JSONL", async () => {
    const dir = await makeFixture([
      { id: "t1", domain: "web", states: [{ a: 1 }] },
      { id: "t2", domain: "enterprise", states: [{ a: 2 }] },
    ]);

    const reader = await openTrajectories(dir);
    try {
      expect(reader.has("t1")).toBe(true);
      expect(reader.has("t2")).toBe(true);
      expect(reader.has("t-nope")).toBe(false);

      const t1 = await reader.get("t1");
      expect(t1.id).toBe("t1");
      // `.passthrough()` preserves unknown structured fields
      expect((t1 as Record<string, unknown>)["states"]).toEqual([{ a: 1 }]);
    } finally {
      await reader.close();
    }

    // Index file landed on disk and points at the same JSONL
    const index = await readIndex(dir);
    expect(index.version).toBe(1);
    expect(index.source.filename).toBe(JSONL_FILENAME);
    expect(Object.keys(index.entries).sort()).toEqual(["t1", "t2"]);
    // Each entry has a sane non-negative offset and a positive length
    for (const id of ["t1", "t2"]) {
      const entry = index.entries[id]!;
      expect(entry.offset).toBeGreaterThanOrEqual(0);
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  test("get(id) reads bytes at the recorded offset and parses correctly", async () => {
    // Construct rows whose first-character offsets in the file are
    // easy to compute — t1's payload starts at byte 0, and we want
    // to confirm the indexed offset for t2 corresponds to the
    // character right after t1's newline.
    const t1 = { id: "t1", domain: "web", value: "first" };
    const t2 = { id: "t2", domain: "web", value: "second" };
    const dir = await makeFixture([t1, t2]);

    const reader = await openTrajectories(dir);
    try {
      const indexFromDisk = await readIndex(dir);
      const expectedT2Offset = Buffer.byteLength(
        `${JSON.stringify(t1)}\n`,
        "utf8",
      );
      expect(indexFromDisk.entries["t2"]?.offset).toBe(expectedT2Offset);

      const fetched = await reader.get("t2");
      expect(fetched).toEqual(t2);
    } finally {
      await reader.close();
    }
  });

  test("close() is idempotent and blocks further get() calls", async () => {
    const dir = await makeFixture([{ id: "t1", domain: "web" }]);
    const reader = await openTrajectories(dir);
    await reader.close();
    await reader.close(); // second close is a no-op, must not throw
    await expect(reader.get("t1")).rejects.toThrow(/closed/);
  });
});

describe("openTrajectories — index reuse and invalidation", () => {
  test("reuses an existing index when size + mtime match", async () => {
    const dir = await makeFixture([
      { id: "t1", domain: "web" },
      { id: "t2", domain: "web" },
    ]);

    // First open builds the index.
    const reader1 = await openTrajectories(dir);
    await reader1.close();
    const beforeBytes = await readFile(join(dir, INDEX_FILENAME));
    const beforeStat = await stat(join(dir, INDEX_FILENAME));

    // Second open should NOT rewrite the file (mtime stays put).
    const reader2 = await openTrajectories(dir);
    await reader2.close();
    const afterStat = await stat(join(dir, INDEX_FILENAME));
    const afterBytes = await readFile(join(dir, INDEX_FILENAME));

    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);
  });

  test("rebuilds when the JSONL's mtime changes (size unchanged)", async () => {
    const dir = await makeFixture([
      { id: "t1", domain: "web" },
      { id: "t2", domain: "web" },
    ]);
    const r1 = await openTrajectories(dir);
    await r1.close();
    const beforeIndex = await readIndex(dir);

    // Bump the JSONL's mtime to invalidate the index. Use a 60s
    // bump because some CI filesystems (ext4, some Docker overlays)
    // floor mtimes to second precision, so anything finer can
    // round-trip to the same value the previous build saw.
    const jsonlPath = join(dir, JSONL_FILENAME);
    const future = new Date(Date.now() + 60_000);
    await utimes(jsonlPath, future, future);

    const r2 = await openTrajectories(dir);
    await r2.close();

    // Assert the rebuild via the canonical signal — the index's
    // `source.mtimeMs` was refreshed to the bumped JSONL mtime.
    // Comparing the index FILE's mtime stat is flaky on CI: the
    // rewrite happens in <1ms and the filesystem mtime resolution
    // (ms on ext4, coarser inside some Docker volumes) ties the
    // before/after values to the same number even though the file
    // was genuinely rewritten. See PR-11a (#TBD).
    const afterIndex = await readIndex(dir);
    expect(afterIndex.source.mtimeMs).toBeGreaterThan(
      beforeIndex.source.mtimeMs,
    );
    expect(afterIndex.source.mtimeMs).toBe(future.getTime());
    expect(Object.keys(afterIndex.entries).sort()).toEqual(["t1", "t2"]);
  });

  test("rebuilds when the existing index file is corrupt", async () => {
    const dir = await makeFixture([{ id: "t1", domain: "web" }]);
    await writeFile(join(dir, INDEX_FILENAME), "{not-valid-json", "utf8");

    const reader = await openTrajectories(dir);
    try {
      expect(reader.has("t1")).toBe(true);
    } finally {
      await reader.close();
    }
    // Rebuilt cleanly
    const index = await readIndex(dir);
    expect(index.version).toBe(1);
    expect(index.entries["t1"]).toBeDefined();
  });

  test("rebuilds when the existing index has the wrong version", async () => {
    const dir = await makeFixture([{ id: "t1", domain: "web" }]);
    const bogus: Record<string, unknown> = {
      version: 999,
      source: {
        filename: JSONL_FILENAME,
        size: 1,
        mtimeMs: 1,
      },
      entries: { t1: { offset: 0, length: 1 } },
    };
    await writeFile(join(dir, INDEX_FILENAME), JSON.stringify(bogus), "utf8");

    const reader = await openTrajectories(dir);
    try {
      // If we hadn't rejected the bad version we'd be reading 1 byte
      // at offset 0, which is not a valid trajectory JSON line.
      const t1 = await reader.get("t1");
      expect(t1.id).toBe("t1");
    } finally {
      await reader.close();
    }
  });
});

describe("openTrajectories — error paths", () => {
  test("missing trajectories.jsonl surfaces a helpful operator error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
    await expect(openTrajectories(dir)).rejects.toThrow(
      /trajectories\.jsonl not found.*data\/download\.sh/,
    );
  });

  test("malformed JSONL throws at build time with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
    await writeFile(
      join(dir, JSONL_FILENAME),
      [JSON.stringify({ id: "t1", domain: "web" }), "{not-valid-json"].join(
        "\n",
      ),
      "utf8",
    );
    await expect(openTrajectories(dir)).rejects.toThrow(
      /Failed to parse trajectories\.jsonl at line 2/,
    );
  });

  test("rows missing the required `id` field fail schema validation at build time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
    await writeFile(
      join(dir, JSONL_FILENAME),
      [
        JSON.stringify({ id: "t1", domain: "web" }),
        JSON.stringify({ domain: "enterprise" }), // no id
      ].join("\n"),
      "utf8",
    );
    await expect(openTrajectories(dir)).rejects.toThrow(
      /trajectories\.jsonl line 2 failed schema validation/,
    );
  });

  test("duplicate trajectory ids fail at build time with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
    await writeFile(
      join(dir, JSONL_FILENAME),
      [
        JSON.stringify({ id: "t1", domain: "web" }),
        JSON.stringify({ id: "t1", domain: "enterprise" }),
      ].join("\n"),
      "utf8",
    );
    await expect(openTrajectories(dir)).rejects.toThrow(
      /Duplicate trajectory id "t1" at line 2/,
    );
  });

  test("blank lines in the JSONL are skipped during index build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-reader-"));
    await writeFile(
      join(dir, JSONL_FILENAME),
      ["", JSON.stringify({ id: "t1", domain: "web" }), "", ""].join("\n"),
      "utf8",
    );
    const reader = await openTrajectories(dir);
    try {
      expect(reader.has("t1")).toBe(true);
      const index = await readIndex(dir);
      expect(Object.keys(index.entries)).toEqual(["t1"]);
    } finally {
      await reader.close();
    }
  });

  test("get(id) for an unknown id throws a helpful error", async () => {
    const dir = await makeFixture([{ id: "t1", domain: "web" }]);
    const reader = await openTrajectories(dir);
    try {
      await expect(reader.get("t-nope")).rejects.toThrow(
        /Trajectory id "t-nope" not present/,
      );
    } finally {
      await reader.close();
    }
  });
});

describe("openTrajectories — chunk boundary handling", () => {
  test("indexes correctly when records span the streaming chunk boundary", async () => {
    // Build enough rows that the JSONL definitely exceeds the
    // streaming chunk size (1 MiB). Each row is ~32 KB of states,
    // so ~64 rows ≈ 2 MiB.
    const rows = Array.from({ length: 64 }, (_, i) => ({
      id: `t${i}`,
      domain: "web",
      // Long padding string to ensure the chunk boundary cuts across
      // line breaks rather than landing on one.
      padding: "x".repeat(32_000),
    }));
    const dir = await makeFixture(rows);

    const reader = await openTrajectories(dir);
    try {
      // Spot-check both the first row, a middle row, and the last —
      // those are the windows most likely to expose a stale
      // `pendingStartOffset`.
      for (const id of ["t0", "t31", "t63"]) {
        expect(reader.has(id)).toBe(true);
        const rec = await reader.get(id);
        expect(rec.id).toBe(id);
        expect((rec as Record<string, unknown>)["padding"]).toBe(
          "x".repeat(32_000),
        );
      }
    } finally {
      await reader.close();
    }
  });
});

describe("createInMemoryTrajectoryReader", () => {
  test("has + get behave like the on-disk reader", async () => {
    const reader = createInMemoryTrajectoryReader([
      { id: "t1", domain: "web", value: 1 },
      { id: "t2", domain: "web", value: 2 },
    ]);
    expect(reader.has("t1")).toBe(true);
    expect(reader.has("t-nope")).toBe(false);
    const t1 = await reader.get("t1");
    expect(t1).toEqual({ id: "t1", domain: "web", value: 1 });
    await reader.close();
  });

  test("rejects duplicate ids at construction time", () => {
    expect(() =>
      createInMemoryTrajectoryReader([
        { id: "t1", domain: "web" },
        { id: "t1", domain: "enterprise" },
      ]),
    ).toThrow(/Duplicate trajectory id "t1"/);
  });

  test("get(unknown id) throws", async () => {
    const reader = createInMemoryTrajectoryReader([
      { id: "t1", domain: "web" },
    ]);
    await expect(reader.get("t-nope")).rejects.toThrow(
      /not present in in-memory reader/,
    );
  });
});
