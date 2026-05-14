import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTestDef, TestDefSchema } from "../test-def";

let tmp: string;
let originalDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evals-test-def-test-"));
  originalDir = process.env.EVALS_TESTS_DIR;
  process.env.EVALS_TESTS_DIR = tmp;
});

afterEach(() => {
  if (originalDir === undefined) {
    delete process.env.EVALS_TESTS_DIR;
  } else {
    process.env.EVALS_TESTS_DIR = originalDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, body: unknown): void {
  writeFileSync(join(tmp, `${name}.json`), JSON.stringify(body));
}

describe("TestDefSchema", () => {
  test("accepts a minimal valid test definition", () => {
    const result = TestDefSchema.safeParse({
      id: "mem.single_turn.timeline_recall",
      shape: "single_turn",
      dimensions: ["memory"],
      objective: "Recall a date from conversation history.",
    });
    expect(result.success).toBe(true);
  });

  test("accepts arbitrary shape string (open taxonomy)", () => {
    const result = TestDefSchema.safeParse({
      id: "novel.shape.test",
      shape: "tiered_mixed_orchestration",
      dimensions: ["memory", "judgment"],
      objective: "A future test shape we haven't named yet.",
    });
    expect(result.success).toBe(true);
  });

  test("allows passthrough fields for future extension (PR-3)", () => {
    const parsed = TestDefSchema.parse({
      id: "x.y.z",
      shape: "single_turn",
      dimensions: ["memory"],
      objective: "ok",
      fixture: "fixtures/conv-with-allergy.json",
      simulator: {
        script: ["What date did I mention my partner's peanut allergy?"],
      },
      scorer: {
        type: "single_turn_with_citation",
        expected_date: "2025-04-12",
      },
    });
    expect(parsed.id).toBe("x.y.z");
    // Passthrough preserves unknown fields
    expect((parsed as { fixture?: string }).fixture).toBe(
      "fixtures/conv-with-allergy.json",
    );
  });

  test("rejects empty dimensions array", () => {
    const result = TestDefSchema.safeParse({
      id: "x",
      shape: "single_turn",
      dimensions: [],
      objective: "ok",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty objective", () => {
    const result = TestDefSchema.safeParse({
      id: "x",
      shape: "single_turn",
      dimensions: ["memory"],
      objective: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing shape", () => {
    const result = TestDefSchema.safeParse({
      id: "x",
      dimensions: ["memory"],
      objective: "ok",
    });
    expect(result.success).toBe(false);
  });
});

describe("loadTestDef", () => {
  test("loads a well-formed test definition", async () => {
    write("mem.single_turn.timeline_recall", {
      id: "mem.single_turn.timeline_recall",
      shape: "single_turn",
      dimensions: ["memory"],
      objective:
        "Agent returns the date a fact was first mentioned and cites the source turn.",
    });
    const t = await loadTestDef("mem.single_turn.timeline_recall");
    expect(t.id).toBe("mem.single_turn.timeline_recall");
    expect(t.shape).toBe("single_turn");
    expect(t.dimensions).toEqual(["memory"]);
  });

  test("throws when file does not exist", async () => {
    await expect(loadTestDef("missing.test.def")).rejects.toThrow(/not found/);
  });

  test("throws when JSON is malformed", async () => {
    writeFileSync(join(tmp, "broken.json"), "not json {{");
    await expect(loadTestDef("broken")).rejects.toThrow(/not valid JSON/);
  });

  test("throws when schema fails", async () => {
    write("bad", { id: "bad", shape: "single_turn", dimensions: [] }); // empty dims + missing objective
    await expect(loadTestDef("bad")).rejects.toThrow(/schema validation/);
  });

  test("throws when file id mismatches requested id", async () => {
    write("requested-id", {
      id: "actual-id-in-file",
      shape: "single_turn",
      dimensions: ["memory"],
      objective: "ok",
    });
    await expect(loadTestDef("requested-id")).rejects.toThrow(/id mismatch/);
  });
});
