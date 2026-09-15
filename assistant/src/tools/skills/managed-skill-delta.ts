import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTwoFilesPatch } from "diff";

import {
  getManagedSkillDir,
  validateCompanionPath,
} from "../../skills/managed-store.js";

export type ManagedSkillContentSnapshot = Map<string, string | null>;

/** Read the skill files one scaffold invocation can modify. */
export function snapshotManagedSkillContent(
  skillId: string,
  companionPaths: string[],
): ManagedSkillContentSnapshot {
  const skillDir = getManagedSkillDir(skillId);
  const relativePaths = new Set(["SKILL.md"]);
  for (const companionPath of companionPaths) {
    const resolved = validateCompanionPath(skillDir, companionPath);
    if (resolved.error || !resolved.resolvedPath) {
      continue;
    }
    relativePaths.add(companionPath);
  }

  const snapshot: ManagedSkillContentSnapshot = new Map();
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = join(skillDir, relativePath);
    snapshot.set(
      relativePath,
      existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : null,
    );
  }
  return snapshot;
}

/** Build a plain unified diff from a pre-write snapshot to the persisted files. */
export function diffManagedSkillContent(
  skillId: string,
  before: ManagedSkillContentSnapshot,
): string {
  const skillDir = getManagedSkillDir(skillId);
  const patches: string[] = [];
  for (const [relativePath, oldContent] of before) {
    const absolutePath = join(skillDir, relativePath);
    const newContent = existsSync(absolutePath)
      ? readFileSync(absolutePath, "utf-8")
      : null;
    if (oldContent === newContent) {
      continue;
    }
    const displayPath = `skills/${skillId}/${relativePath}`;
    patches.push(
      createTwoFilesPatch(
        oldContent === null ? "/dev/null" : `a/${displayPath}`,
        newContent === null ? "/dev/null" : `b/${displayPath}`,
        oldContent ?? "",
        newContent ?? "",
        undefined,
        undefined,
        { context: 3 },
      ),
    );
  }
  return patches.join("\n");
}
