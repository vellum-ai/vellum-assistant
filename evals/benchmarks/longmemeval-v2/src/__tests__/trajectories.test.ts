import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { BenchmarkItem } from "../loader";
import {
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_TRAJECTORY_DIR,
  loadTrajectories,
  materializeWorkspaceFiles,
} from "../trajectories";

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

describe("loadTrajectories", () => {
  test("returns a Map keyed by trajectory id with passthrough payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await writeFile(
      join(dir, "trajectories.jsonl"),
      [
        JSON.stringify({
          id: "t1",
          domain: "web",
          states: [{ action: "click", observation: "ok" }],
        }),
        JSON.stringify({
          id: "t2",
          domain: "enterprise",
          states: [{ action: "search", observation: "miss" }],
        }),
      ].join("\n"),
      "utf8",
    );

    const trajectories = await loadTrajectories(dir);
    expect(trajectories.size).toBe(2);
    expect(trajectories.get("t1")?.domain).toBe("web");
    // `.passthrough()` preserves unknown structured fields verbatim
    const t2 = trajectories.get("t2") as Record<string, unknown>;
    expect(t2["states"]).toEqual([{ action: "search", observation: "miss" }]);
  });

  test("reports a helpful error when trajectories.jsonl is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await expect(loadTrajectories(dir)).rejects.toThrow(
      /trajectories\.jsonl not found.*data\/download\.sh/,
    );
  });

  test("rejects malformed JSONL with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await writeFile(
      join(dir, "trajectories.jsonl"),
      [JSON.stringify({ id: "t1", domain: "web" }), "{not-valid-json"].join(
        "\n",
      ),
      "utf8",
    );

    await expect(loadTrajectories(dir)).rejects.toThrow(
      /Failed to parse trajectories\.jsonl at line 2/,
    );
  });

  test("rejects rows missing the required `id` field with schema details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await writeFile(
      join(dir, "trajectories.jsonl"),
      [
        JSON.stringify({ id: "t1", domain: "web" }),
        JSON.stringify({ domain: "enterprise" }), // no id
      ].join("\n"),
      "utf8",
    );

    await expect(loadTrajectories(dir)).rejects.toThrow(
      /trajectories\.jsonl line 2 failed schema validation/,
    );
  });

  test("rejects duplicate trajectory ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await writeFile(
      join(dir, "trajectories.jsonl"),
      [
        JSON.stringify({ id: "t1", domain: "web" }),
        JSON.stringify({ id: "t1", domain: "enterprise" }),
      ].join("\n"),
      "utf8",
    );

    await expect(loadTrajectories(dir)).rejects.toThrow(
      /Duplicate trajectory id "t1" at line 2/,
    );
  });

  test("skips blank lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-traj-"));
    await writeFile(
      join(dir, "trajectories.jsonl"),
      ["", JSON.stringify({ id: "t1", domain: "web" }), "", ""].join("\n"),
      "utf8",
    );

    const trajectories = await loadTrajectories(dir);
    expect(trajectories.size).toBe(1);
    expect(trajectories.get("t1")?.id).toBe("t1");
  });
});

describe("materializeWorkspaceFiles", () => {
  test("returns one write per trajectory id in haystack order plus a manifest", () => {
    const trajectories = new Map([
      ["t1", { id: "t1", domain: "web", states: [{ a: 1 }] }],
      ["t2", { id: "t2", domain: "web", states: [{ a: 2 }] }],
      ["t3", { id: "t3", domain: "web", states: [{ a: 3 }] }],
    ]);
    // Item asks for them OUT of insertion order — the writer must
    // preserve the haystack's declared order, not the map's.
    const item = makeItem({ trajectoryIds: ["t3", "t1", "t2"] });

    const writes = materializeWorkspaceFiles(item, trajectories);
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

    // Manifest carries question + haystack order
    const manifest = JSON.parse(writes[3]!.content);
    expect(manifest).toEqual({
      questionId: "q1",
      ability: "static-state-recall",
      question: "Q1?",
      trajectoryDir: WORKSPACE_TRAJECTORY_DIR,
      trajectoryIds: ["t3", "t1", "t2"],
      count: 3,
    });
  });

  test("throws with all missing trajectory ids listed", () => {
    const trajectories = new Map([["t1", { id: "t1", domain: "web" }]]);
    const item = makeItem({ trajectoryIds: ["t1", "t99", "t100"] });

    expect(() => materializeWorkspaceFiles(item, trajectories)).toThrow(
      /missing from trajectories\.jsonl: t99, t100/,
    );
  });

  test("rejects an item with an empty haystack defensively", () => {
    const item = makeItem({ trajectoryIds: [] });
    expect(() => materializeWorkspaceFiles(item, new Map())).toThrow(
      /q1 has no trajectory ids/,
    );
  });

  test("respects custom trajectoryDir and manifestPath overrides", () => {
    const trajectories = new Map([["t1", { id: "t1", domain: "web" }]]);
    const item = makeItem({ trajectoryIds: ["t1"] });

    const writes = materializeWorkspaceFiles(item, trajectories, {
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
