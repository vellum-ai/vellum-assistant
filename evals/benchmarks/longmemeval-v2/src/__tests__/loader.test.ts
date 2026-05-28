import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { loadLongMemEvalV2 } from "../loader";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

describe("loadLongMemEvalV2", () => {
  test("joins questions against the small-tier haystack", async () => {
    const items = await loadLongMemEvalV2({
      dataRoot: FIXTURES,
      tier: "small",
    });

    expect(items.map((i) => i.questionId)).toEqual(["q_001", "q_002", "q_003"]);
    expect(items[0]).toMatchObject({
      questionId: "q_001",
      ability: "static-state-recall",
      question: "What is the URL of the project settings page?",
      answer: "/settings/project",
      trajectoryIds: ["traj_a", "traj_b"],
    });
    expect(items[1].trajectoryIds).toEqual(["traj_b", "traj_c", "traj_d"]);
    expect(items[2].trajectoryIds).toEqual(["traj_e"]);
    // `extra_field_for_passthrough` on q_003 should not crash the loader
    // — passthrough on the raw schema preserves forward compatibility.
    expect(items[2].ability).toBe("workflow-knowledge");
  });

  test("resolves a different trajectory list for the medium tier", async () => {
    // medium-tier fixture intentionally omits q_003, so loading it should
    // surface the strict-join error rather than silently dropping items.
    await expect(
      loadLongMemEvalV2({ dataRoot: FIXTURES, tier: "medium" }),
    ).rejects.toThrow(
      /Tier "medium" haystack mapping is missing 1 question id.*q_003/,
    );
  });

  test("loads medium tier when every question has a haystack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await mkdir(join(dir, "haystacks"), { recursive: true });
    await writeFile(
      join(dir, "questions.jsonl"),
      [
        JSON.stringify({
          id: "q1",
          question_type: "static-state-recall",
          question: "Q1?",
          answer: "A1",
          eval_function: "norm_phrase_set_match",
        }),
        JSON.stringify({
          id: "q2",
          question_type: "premise-awareness",
          question: "Q2?",
          answer: "A2",
          eval_function: "llm_abstention_checker",
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "haystacks", "lme_v2_medium.json"),
      JSON.stringify({
        q1: ["t1", "t2", "t3"],
        q2: ["t4"],
      }),
      "utf8",
    );

    const items = await loadLongMemEvalV2({ dataRoot: dir, tier: "medium" });
    expect(items).toHaveLength(2);
    expect(items[0].trajectoryIds).toEqual(["t1", "t2", "t3"]);
  });

  test("reports a helpful error when questions.jsonl is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await expect(
      loadLongMemEvalV2({ dataRoot: dir, tier: "small" }),
    ).rejects.toThrow(/questions\.jsonl not found.*data\/download\.sh/);
  });

  test("reports a helpful error when the tier haystack is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await writeFile(join(dir, "questions.jsonl"), "", "utf8");
    await expect(
      loadLongMemEvalV2({ dataRoot: dir, tier: "small" }),
    ).rejects.toThrow(
      /haystack mapping for tier "small" not found.*data\/download\.sh/,
    );
  });

  test("rejects malformed questions.jsonl with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await mkdir(join(dir, "haystacks"), { recursive: true });
    await writeFile(
      join(dir, "questions.jsonl"),
      [
        JSON.stringify({
          id: "q1",
          question_type: "static-state-recall",
          question: "Q1?",
          answer: "A1",
          eval_function: "norm_phrase_set_match",
        }),
        // Missing required `answer` field.
        JSON.stringify({
          id: "q2",
          question_type: "premise-awareness",
          question: "Q2?",
          eval_function: "llm_abstention_checker",
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "haystacks", "lme_v2_small.json"),
      JSON.stringify({ q1: ["t1"], q2: ["t2"] }),
      "utf8",
    );

    await expect(
      loadLongMemEvalV2({ dataRoot: dir, tier: "small" }),
    ).rejects.toThrow(/questions\.jsonl line 2 failed schema validation/);
  });

  test("rejects haystack mappings with empty trajectory lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await mkdir(join(dir, "haystacks"), { recursive: true });
    await writeFile(
      join(dir, "questions.jsonl"),
      JSON.stringify({
        id: "q1",
        question_type: "static-state-recall",
        question: "Q1?",
        answer: "A1",
        eval_function: "norm_phrase_set_match",
      }),
      "utf8",
    );
    await writeFile(
      join(dir, "haystacks", "lme_v2_small.json"),
      JSON.stringify({ q1: [] }),
      "utf8",
    );

    await expect(
      loadLongMemEvalV2({ dataRoot: dir, tier: "small" }),
    ).rejects.toThrow(/failed schema validation/);
  });

  test("rejects V1-shaped rows that use the legacy `question_id` field", async () => {
    // V1 of LongMemEval used `question_id`; V2 (per SCHEMA.md) uses `id`.
    // If someone wires the loader up against a V1 dump we want a loud,
    // schema-validation failure with a line number — not a silent
    // "haystack mapping is missing 1 question id" mismatch on a synthetic
    // `undefined` key.
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await mkdir(join(dir, "haystacks"), { recursive: true });
    await writeFile(
      join(dir, "questions.jsonl"),
      JSON.stringify({
        question_id: "q1",
        question_type: "static-state-recall",
        question: "Q1?",
        answer: "A1",
        eval_function: "norm_phrase_set_match",
      }),
      "utf8",
    );
    await writeFile(
      join(dir, "haystacks", "lme_v2_small.json"),
      JSON.stringify({ q1: ["t1"] }),
      "utf8",
    );

    await expect(
      loadLongMemEvalV2({ dataRoot: dir, tier: "small" }),
    ).rejects.toThrow(/questions\.jsonl line 1 failed schema validation/);
  });

  test("skips blank lines in questions.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lme-v2-"));
    await mkdir(join(dir, "haystacks"), { recursive: true });
    await writeFile(
      join(dir, "questions.jsonl"),
      [
        "",
        JSON.stringify({
          id: "q1",
          question_type: "static-state-recall",
          question: "Q1?",
          answer: "A1",
          eval_function: "norm_phrase_set_match",
        }),
        "",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "haystacks", "lme_v2_small.json"),
      JSON.stringify({ q1: ["t1"] }),
      "utf8",
    );

    const items = await loadLongMemEvalV2({ dataRoot: dir, tier: "small" });
    expect(items).toHaveLength(1);
    expect(items[0].questionId).toBe("q1");
  });
});
