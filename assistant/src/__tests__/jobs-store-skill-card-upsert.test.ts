import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { upsertSkillCardInsertJob } from "../persistence/jobs-store.js";
import { memoryJobs } from "../persistence/schema/index.js";

function skillEntry(skillId: string, name = `Skill ${skillId}`) {
  return { skillId, name, description: `Does ${skillId}` };
}

function pendingRows() {
  const db = getMemoryDb()!;
  return db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "skill_card_insert"))
    .all();
}

function parsedSkills(payload: string): Array<{ skillId: string }> {
  return (JSON.parse(payload) as { skills: Array<{ skillId: string }> }).skills;
}

describe("upsertSkillCardInsertJob payload merge", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    const db = getMemoryDb()!;
    db.run("DELETE FROM memory_jobs");
  });

  test("inserts a fresh pending row when none exists for the run", () => {
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a")],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.sourceConversationId).toBe("src-1");
    expect(payload.runConversationId).toBe("run-1");
    expect(parsedSkills(rows[0]!.payload).map((s) => s.skillId)).toEqual([
      "skill-a",
    ]);
  });

  test("a second create in the same run merges its skill into the pending payload", () => {
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a")],
    });
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-b")],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    expect(parsedSkills(rows[0]!.payload).map((s) => s.skillId)).toEqual([
      "skill-a",
      "skill-b",
    ]);
  });

  test("re-enqueueing the same skill is deduplicated by skillId (pending entry wins)", () => {
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a", "Original Name")],
    });
    // The handler's still-mid-turn re-upsert replays the whole snapshot.
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a", "Replayed Name"), skillEntry("skill-b")],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    const skills = parsedSkills(rows[0]!.payload) as Array<{
      skillId: string;
      name: string;
    }>;
    expect(skills.map((s) => s.skillId)).toEqual(["skill-a", "skill-b"]);
    expect(skills[0]!.name).toBe("Original Name");
  });

  test("the earliest runAfter wins across merges", () => {
    const later = Date.now() + 300_000;
    const sooner = Date.now();
    upsertSkillCardInsertJob(
      {
        sourceConversationId: "src-1",
        runConversationId: "run-1",
        skills: [skillEntry("skill-a")],
      },
      later,
    );
    upsertSkillCardInsertJob(
      {
        sourceConversationId: "src-1",
        runConversationId: "run-1",
        skills: [skillEntry("skill-b")],
      },
      sooner,
    );
    // A later-scheduled follow-up must not push the sooner row back out.
    upsertSkillCardInsertJob(
      {
        sourceConversationId: "src-1",
        runConversationId: "run-1",
        skills: [skillEntry("skill-c")],
      },
      later,
    );

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAfter).toBe(sooner);
    expect(parsedSkills(rows[0]!.payload).map((s) => s.skillId)).toEqual([
      "skill-a",
      "skill-b",
      "skill-c",
    ]);
  });

  test("distinct runs keep distinct pending rows", () => {
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a")],
    });
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-2",
      skills: [skillEntry("skill-b")],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(2);
    const byRun = new Map(
      rows.map((r) => [
        (JSON.parse(r.payload) as { runConversationId: string })
          .runConversationId,
        parsedSkills(r.payload).map((s) => s.skillId),
      ]),
    );
    expect(byRun.get("run-1")).toEqual(["skill-a"]);
    expect(byRun.get("run-2")).toEqual(["skill-b"]);
  });

  test("a non-pending row does not coalesce — a fresh pending row is created", () => {
    // The claimed row a handler re-upserts from is `running`; its replacement
    // must be a NEW pending row, never a mutation of the claimed one.
    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a")],
    });
    const db = getMemoryDb()!;
    db.update(memoryJobs)
      .set({ status: "running" })
      .where(
        and(
          eq(memoryJobs.type, "skill_card_insert"),
          eq(memoryJobs.status, "pending"),
        ),
      )
      .run();

    upsertSkillCardInsertJob({
      sourceConversationId: "src-1",
      runConversationId: "run-1",
      skills: [skillEntry("skill-a")],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "running"]);
  });
});
