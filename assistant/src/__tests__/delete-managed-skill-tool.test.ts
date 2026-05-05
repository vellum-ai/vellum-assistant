import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { executeDeleteManagedSkill } from "../tools/skills/delete-managed.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

function createSkill(id: string): void {
  const skillDir = join(TEST_DIR, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    '---\nname: "Test"\ndescription: "Test"\n---\n\nBody.\n',
  );
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(join(TEST_DIR, "skills"), { recursive: true, force: true });
});

describe("delete_managed_skill tool", () => {
  test("deletes existing skill while leaving a stale SKILLS.md index unchanged", async () => {
    createSkill("doomed");
    createSkill("survivor");
    const indexPath = join(TEST_DIR, "skills", "SKILLS.md");
    const staleIndex = "- doomed\n- survivor\n";
    writeFileSync(indexPath, staleIndex);

    const result = await executeDeleteManagedSkill(
      {
        skill_id: "doomed",
        remove_from_index: false,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.deleted).toBe(true);
    expect(parsed.skill_id).toBe("doomed");
    expect(parsed.index_updated).toBe(false);

    expect(existsSync(join(TEST_DIR, "skills", "doomed"))).toBe(false);

    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf-8")).toBe(staleIndex);
  });

  test("returns error for non-existent skill", async () => {
    const result = await executeDeleteManagedSkill(
      {
        skill_id: "ghost",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("rejects missing skill_id", async () => {
    const result = await executeDeleteManagedSkill({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("skill_id is required");
  });

  test("rejects invalid skill_id", async () => {
    const result = await executeDeleteManagedSkill(
      {
        skill_id: "../escape",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("traversal");
  });
});
