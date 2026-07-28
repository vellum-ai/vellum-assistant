/**
 * Companion-file IPC methods behind `assistant skills companion …`.
 *
 * These run against the real managed-skill store (the test preload points
 * VELLUM_WORKSPACE_DIR at a per-file temp dir), so the assertions cover the
 * daemon-side contract the CLI depends on: the store's rejections surface as
 * the right RouteError class, and the ownership gate applies to every caller
 * — a CLI process carries no request origin, so there is no "interactive"
 * relaxation to test for.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  BadRequestError,
  NotFoundError,
} from "../../../runtime/routes/errors.js";
import { createManagedSkill } from "../../../skills/managed-store.js";
import {
  handleSkillsCompanionAdd,
  handleSkillsCompanionList,
  handleSkillsCompanionRemove,
} from "../skills-companion-ipc-routes.js";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

function seedAssistantSkill(id: string): void {
  createManagedSkill({
    id,
    name: id,
    description: `${id} description`,
    bodyMarkdown: "Body.",
    author: "assistant",
    overwrite: true,
  });
}

function writeSource(name: string, content = "print('ok')\n"): string {
  const sourcePath = join(TEST_DIR, name);
  writeFileSync(sourcePath, content, "utf-8");
  return sourcePath;
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

describe("skills_companion_add", () => {
  test("copies the source and reports the written path", () => {
    seedAssistantSkill("ipc-add");
    const from = writeSource("ipc-add.py");

    const result = handleSkillsCompanionAdd({
      body: { skillId: "ipc-add", path: "scripts/ipc-add.py", from },
    }) as { added: boolean; path: string };

    expect(result.added).toBe(true);
    expect(result.path).toContain(join("ipc-add", "scripts", "ipc-add.py"));
  });

  test("maps a missing skill to NotFound", () => {
    const from = writeSource("ipc-missing.py");

    expect(() =>
      handleSkillsCompanionAdd({
        body: { skillId: "ipc-missing", path: "scripts/x.py", from },
      }),
    ).toThrow(NotFoundError);
  });

  test("maps a rejected destination to BadRequest", () => {
    seedAssistantSkill("ipc-reserved");
    const from = writeSource("ipc-reserved.json", "{}");

    expect(() =>
      handleSkillsCompanionAdd({
        body: {
          skillId: "ipc-reserved",
          path: "TOOLS.json",
          from,
          overwrite: true,
        },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects a user-authored skill regardless of caller", () => {
    createManagedSkill({
      id: "ipc-user-authored",
      name: "User Authored",
      description: "Hand written",
      bodyMarkdown: "Body.",
      author: "user",
      overwrite: true,
    });
    const from = writeSource("ipc-user.py");

    expect(() =>
      handleSkillsCompanionAdd({
        body: { skillId: "ipc-user-authored", path: "scripts/x.py", from },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects a malformed request before touching the store", () => {
    expect(() =>
      handleSkillsCompanionAdd({ body: { skillId: "ipc-add" } }),
    ).toThrow();
  });
});

describe("skills_companion_list", () => {
  test("returns companion files without the store-owned files", () => {
    seedAssistantSkill("ipc-list");
    handleSkillsCompanionAdd({
      body: {
        skillId: "ipc-list",
        path: "scripts/listed.py",
        from: writeSource("ipc-listed.py", "12345"),
      },
    });

    const result = handleSkillsCompanionList({
      body: { skillId: "ipc-list" },
    }) as { files: { path: string; bytes: number }[] };

    expect(result.files).toEqual([{ path: "scripts/listed.py", bytes: 5 }]);
  });
});

describe("skills_companion_remove", () => {
  test("removes a companion file", () => {
    seedAssistantSkill("ipc-remove");
    handleSkillsCompanionAdd({
      body: {
        skillId: "ipc-remove",
        path: "scripts/gone.py",
        from: writeSource("ipc-gone.py"),
      },
    });

    const result = handleSkillsCompanionRemove({
      body: { skillId: "ipc-remove", path: "scripts/gone.py" },
    }) as { removed: boolean };

    expect(result.removed).toBe(true);
    expect(
      (
        handleSkillsCompanionList({ body: { skillId: "ipc-remove" } }) as {
          files: unknown[];
        }
      ).files,
    ).toHaveLength(0);
  });

  test("cannot remove a store-owned file", () => {
    seedAssistantSkill("ipc-remove-owned");

    expect(() =>
      handleSkillsCompanionRemove({
        body: { skillId: "ipc-remove-owned", path: "SKILL.md" },
      }),
    ).toThrow(BadRequestError);
  });
});
