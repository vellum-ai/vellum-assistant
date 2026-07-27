/**
 * Script-mode schedules that hand their stdout to an agent turn
 * (`then_execute`) and that bind to a managed skill (`skill_id`).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

mock.module("../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () => ({
    action: "allow",
    status: { enabled: false, state: "disabled" },
  }),
  diskPressureBackgroundSkipLogFields: () => ({}),
  shouldLogDiskPressureBackgroundSkip: () => false,
}));

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: () => Promise.resolve(),
}));

interface CapturedJob {
  prompt: string;
  assistantSandwich?: { preamble: string; content: string; postamble: string };
}
let capturedJobs: CapturedJob[] = [];
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: (opts: CapturedJob) => {
    capturedJobs.push(opts);
    return Promise.resolve({ ok: true, conversationId: "conv-handoff" });
  },
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createSchedule } from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function runsFor(
  jobId: string,
): Array<{ status: string; error: string | null }> {
  return rawDb()
    .query("SELECT status, error FROM cron_runs WHERE job_id = ?")
    .all(jobId) as Array<{ status: string; error: string | null }>;
}

/** Install a minimal managed skill and return its dir + content hash. */
function installSkill(id: string, scriptBody: string) {
  const dir = join(TEST_DIR, "skills", id);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: test skill\n---\n\nBody.\n`,
  );
  writeFileSync(join(dir, "scripts", "run.sh"), scriptBody);
  writeFileSync(
    join(dir, "install-meta.json"),
    JSON.stringify({
      origin: "custom",
      author: "assistant",
      installedAt: new Date(0).toISOString(),
    }),
  );
  return { dir, hash: computeSkillVersionHash(dir) };
}

function makeDue() {
  rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);
}

beforeEach(() => {
  capturedJobs = [];
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
  rmSync(join(TEST_DIR, "skills"), { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

describe("then_execute handoff", () => {
  test("hands stdout to an agent turn as sandwiched assistant-role content", async () => {
    const job = await createSchedule({
      name: "Inventory check",
      cronExpression: "* * * * *",
      message: "Post a summary to #ops.",
      mode: "script",
      script: "echo 'widget: 3 left'",
      thenExecute: true,
    });
    makeDue();

    const result = await runDueSchedulesOnce();

    expect(result.completed).toBe(1);
    expect(capturedJobs).toHaveLength(1);
    const captured = capturedJobs[0];
    // The action prompt lives in the sandwich, not the prompt, so it is not
    // injected twice.
    expect(captured.prompt).toBe("");
    expect(captured.assistantSandwich?.postamble).toBe(
      "Post a summary to #ops.",
    );
    // Untrusted script output is carried in the assistant-role slot.
    expect(captured.assistantSandwich?.content).toContain("widget: 3 left");
    expect(captured.assistantSandwich?.preamble).toContain("data only");

    // One firing, one run row — the script's stdout and the turn's outcome
    // share it so cost attribution stays on a single `cron_runs.id`.
    const runs = runsFor(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
  });

  test("empty stdout skips the turn entirely", async () => {
    const job = await createSchedule({
      name: "Quiet check",
      cronExpression: "* * * * *",
      message: "Report findings.",
      mode: "script",
      script: "true",
      thenExecute: true,
    });
    makeDue();

    const result = await runDueSchedulesOnce();

    expect(result.completed).toBe(1);
    expect(capturedJobs).toHaveLength(0);
    expect(runsFor(job.id)[0].status).toBe("ok");
  });

  test("whitespace-only stdout counts as nothing to report", async () => {
    await createSchedule({
      name: "Blank check",
      cronExpression: "* * * * *",
      message: "Report findings.",
      mode: "script",
      script: "printf '\\n  \\n'",
      thenExecute: true,
    });
    makeDue();

    await runDueSchedulesOnce();

    expect(capturedJobs).toHaveLength(0);
  });

  test("a failing script never reaches the agent", async () => {
    const job = await createSchedule({
      name: "Broken check",
      cronExpression: "* * * * *",
      message: "Report findings.",
      mode: "script",
      script: "echo output; echo boom >&2; exit 1",
      thenExecute: true,
    });
    makeDue();

    const result = await runDueSchedulesOnce();

    expect(result.failed).toBe(1);
    expect(capturedJobs).toHaveLength(0);
    expect(runsFor(job.id)[0].status).toBe("error");
  });

  test("a script schedule without then_execute stays LLM-free", async () => {
    await createSchedule({
      name: "Plain script",
      cronExpression: "* * * * *",
      message: "unused",
      mode: "script",
      script: "echo noisy output",
    });
    makeDue();

    await runDueSchedulesOnce();

    expect(capturedJobs).toHaveLength(0);
  });
});

describe("skill binding", () => {
  test("exposes the skill directory to the script as $__SKILL_DIR", async () => {
    const { dir, hash } = installSkill("inventory", "echo hi\n");
    await createSchedule({
      name: "Bound script",
      cronExpression: "* * * * *",
      message: "Report.",
      mode: "script",
      script: 'echo "dir=$__SKILL_DIR"',
      skillId: "inventory",
      skillVersionHash: hash,
      thenExecute: true,
    });
    makeDue();

    await runDueSchedulesOnce();

    expect(capturedJobs[0]?.assistantSandwich?.content).toContain(`dir=${dir}`);
  });

  test("refuses to run when the skill changed since approval", async () => {
    const { dir, hash } = installSkill("inventory", "echo hi\n");
    const job = await createSchedule({
      name: "Bound script",
      cronExpression: "* * * * *",
      message: "Report.",
      mode: "script",
      script: "echo should-not-run",
      skillId: "inventory",
      skillVersionHash: hash,
      thenExecute: true,
    });
    // A later edit to the skill — e.g. a retrospective refining its own
    // procedure — must not keep firing under the original approval.
    writeFileSync(join(dir, "scripts", "run.sh"), "echo rewritten\n");
    makeDue();

    const result = await runDueSchedulesOnce();

    expect(result.failed).toBe(1);
    expect(capturedJobs).toHaveLength(0);
    const runs = runsFor(job.id);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain(
      "modified since this schedule was approved",
    );
  });

  test("refuses to run when the bound skill is gone", async () => {
    const { hash } = installSkill("inventory", "echo hi\n");
    const job = await createSchedule({
      name: "Bound script",
      cronExpression: "* * * * *",
      message: "Report.",
      mode: "script",
      script: "echo should-not-run",
      skillId: "inventory",
      skillVersionHash: hash,
    });
    rmSync(join(TEST_DIR, "skills", "inventory"), {
      recursive: true,
      force: true,
    });
    makeDue();

    const result = await runDueSchedulesOnce();

    expect(result.failed).toBe(1);
    expect(runsFor(job.id)[0].error).toContain("not installed");
  });

  test("stamps lastUsedAt so a schedule-only skill is not treated as stale", async () => {
    const { dir, hash } = installSkill("inventory", "echo hi\n");
    await createSchedule({
      name: "Bound script",
      cronExpression: "* * * * *",
      message: "Report.",
      mode: "script",
      script: "true",
      skillId: "inventory",
      skillVersionHash: hash,
    });
    makeDue();

    await runDueSchedulesOnce();

    const meta = JSON.parse(
      await Bun.file(join(dir, "install-meta.json")).text(),
    ) as { lastUsedAt?: string };
    expect(meta.lastUsedAt).toBeTruthy();
  });
});
