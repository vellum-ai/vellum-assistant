import { describe, expect, test } from "bun:test";

import type { BenchmarkItem } from "../loader";
import {
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_TRAJECTORY_DIR,
  materializeWorkspaceFiles,
} from "../trajectories";
import { createInMemoryTrajectoryReader } from "../trajectory-reader";

function makeItem(overrides: Partial<BenchmarkItem> = {}): BenchmarkItem {
  return {
    questionId: "q1",
    ability: "static-state-recall",
    question: "Q1?",
    answer: "A1",
    evalFunction: "norm_phrase_set_match",
    trajectoryIds: ["t1", "t2"],
    ...overrides,
  };
}

describe("materializeWorkspaceFiles", () => {
  test("returns one write per trajectory id in haystack order plus a manifest", async () => {
    const reader = createInMemoryTrajectoryReader([
      { id: "t1", domain: "web", states: [{ a: 1 }] },
      { id: "t2", domain: "web", states: [{ a: 2 }] },
      { id: "t3", domain: "web", states: [{ a: 3 }] },
    ]);
    // Item asks for them OUT of insertion order — the writer must
    // preserve the haystack's declared order, not the reader's.
    const item = makeItem({ trajectoryIds: ["t3", "t1", "t2"] });

    const writes = await materializeWorkspaceFiles(item, reader);
    expect(writes).toHaveLength(4);
    expect(writes.map((w) => w.path)).toEqual([
      `${WORKSPACE_TRAJECTORY_DIR}/t3.json`,
      `${WORKSPACE_TRAJECTORY_DIR}/t1.json`,
      `${WORKSPACE_TRAJECTORY_DIR}/t2.json`,
      WORKSPACE_MANIFEST_PATH,
    ]);

    // Trajectory contents are the verbatim record (passthrough payload)
    expect(JSON.parse(writes[0]!.content)).toEqual({
      id: "t3",
      domain: "web",
      states: [{ a: 3 }],
    });

    // Manifest carries haystack order only; the question and its ability
    // type are withheld so the ingest turn stays question-blind.
    const manifest = JSON.parse(writes[3]!.content);
    expect(manifest).toEqual({
      questionId: "q1",
      trajectoryDir: WORKSPACE_TRAJECTORY_DIR,
      trajectoryIds: ["t3", "t1", "t2"],
      count: 3,
    });
  });

  test("throws with all missing trajectory ids listed before issuing any reads", async () => {
    let getCount = 0;
    const inner = createInMemoryTrajectoryReader([{ id: "t1", domain: "web" }]);
    const reader = {
      has: (id: string): boolean => inner.has(id),
      get: async (id: string) => {
        getCount += 1;
        return inner.get(id);
      },
      close: async (): Promise<void> => inner.close(),
    };
    const item = makeItem({ trajectoryIds: ["t1", "t99", "t100"] });

    await expect(materializeWorkspaceFiles(item, reader)).rejects.toThrow(
      /missing from trajectories\.jsonl: t99, t100/,
    );
    // Missing ids are surfaced via `has()` checks; we don't waste an
    // I/O round-trip on the present ids when the slice is broken.
    expect(getCount).toBe(0);
  });

  test("rejects an item with an empty haystack defensively", async () => {
    const reader = createInMemoryTrajectoryReader([]);
    const item = makeItem({ trajectoryIds: [] });
    await expect(materializeWorkspaceFiles(item, reader)).rejects.toThrow(
      /q1 has no trajectory ids/,
    );
  });

  test("respects custom trajectoryDir and manifestPath overrides", async () => {
    const reader = createInMemoryTrajectoryReader([
      { id: "t1", domain: "web" },
    ]);
    const item = makeItem({ trajectoryIds: ["t1"] });

    const writes = await materializeWorkspaceFiles(item, reader, {
      trajectoryDir: "custom/path",
      manifestPath: "custom/index.json",
    });

    expect(writes.map((w) => w.path)).toEqual([
      "custom/path/t1.json",
      "custom/index.json",
    ]);
    const manifest = JSON.parse(writes[1]!.content);
    expect(manifest.trajectoryDir).toBe("custom/path");
  });
});
