import * as fs from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-084-remove-legacy-skills-index");

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const rootRealPath = fs.realpathSync(rootDir);
  const candidateRealPath = fs.realpathSync(candidatePath);
  const relativePath = relative(rootRealPath, candidateRealPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function parseLegacySkillIndexEntry(line: string): string | null {
  const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
  if (!match) return null;

  let entry = match[1].trim();
  const markdownLink = entry.match(/^\[.+?\]\((.+?)\)$/);
  if (markdownLink) {
    entry = markdownLink[1].trim();
  } else {
    entry = entry.split(/\s+/)[0]?.trim() ?? "";
  }

  entry = entry.replace(/^`|`$/g, "");
  if (!entry || entry.includes("\0") || isAbsolute(entry)) return null;

  const normalized = normalize(entry);
  if (
    normalized === "." ||
    normalized.startsWith("..") ||
    isAbsolute(normalized)
  ) {
    return null;
  }

  if (basename(normalized).toLowerCase() === "skill.md") {
    const skillDir = dirname(normalized);
    return skillDir === "." ? null : skillDir;
  }

  return normalized;
}

function parseLegacySkillIndexEntries(contents: string): string[] {
  const entries = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseLegacySkillIndexEntry(line);
    if (entry) entries.add(entry);
  }
  return [...entries];
}

function skillFileContentsMatch(
  sourceDir: string,
  destinationDir: string,
): boolean {
  try {
    return (
      fs.readFileSync(join(sourceDir, "SKILL.md"), "utf-8") ===
      fs.readFileSync(join(destinationDir, "SKILL.md"), "utf-8")
    );
  } catch {
    return false;
  }
}

function topLevelPreservationName(relativeSkillDir: string): string {
  return relativeSkillDir
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("__");
}

function getPreservationDestinationDir(
  skillsDir: string,
  sourceDir: string,
  relativeSkillDir: string,
): string | null {
  const skillName = basename(relativeSkillDir);
  if (!skillName || skillName === relativeSkillDir) return null;

  const alternateName = topLevelPreservationName(relativeSkillDir);
  const candidateNames = [
    skillName,
    ...(alternateName && alternateName !== skillName ? [alternateName] : []),
  ];

  for (const candidateName of candidateNames) {
    const destinationDir = join(skillsDir, candidateName);
    if (!fs.existsSync(destinationDir)) return destinationDir;
    if (skillFileContentsMatch(sourceDir, destinationDir)) {
      log.info(
        { destinationDir, sourceDir },
        "Nested indexed skill already preserved at top-level skills directory",
      );
      return null;
    }
  }

  const baseName =
    alternateName && alternateName !== skillName
      ? alternateName
      : `legacy__${skillName}`;
  for (let suffix = 2; ; suffix += 1) {
    const destinationDir = join(skillsDir, `${baseName}-${suffix}`);
    if (!fs.existsSync(destinationDir)) return destinationDir;
    if (skillFileContentsMatch(sourceDir, destinationDir)) {
      log.info(
        { destinationDir, sourceDir },
        "Nested indexed skill already preserved at top-level skills directory",
      );
      return null;
    }
  }
}

function preserveNestedIndexedSkill(
  tempRootDir: string,
  skillsDir: string,
  relativeSkillDir: string,
): void {
  const sourceDir = resolve(skillsDir, relativeSkillDir);
  let destinationDir: string | null = null;

  try {
    if (!fs.existsSync(sourceDir)) return;
    if (!isInsideDirectory(skillsDir, sourceDir)) {
      log.warn(
        { relativeSkillDir, sourceDir },
        "Skipping nested indexed skill that resolves outside skills root",
      );
      return;
    }

    const sourceStat = fs.lstatSync(sourceDir);
    if (!sourceStat.isDirectory()) return;

    const skillFilePath = join(sourceDir, "SKILL.md");
    if (!fs.existsSync(skillFilePath)) return;
    if (!isInsideDirectory(sourceDir, skillFilePath)) {
      log.warn(
        { skillFilePath, sourceDir },
        "Skipping nested indexed skill with SKILL.md outside skill directory",
      );
      return;
    }

    const skillFileStat = fs.lstatSync(skillFilePath);
    if (!skillFileStat.isFile()) return;

    destinationDir = getPreservationDestinationDir(
      skillsDir,
      sourceDir,
      relativeSkillDir,
    );
    if (!destinationDir) return;

    fs.mkdirSync(tempRootDir, { recursive: true });
    const tempDir = join(tempRootDir, basename(destinationDir));
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    fs.cpSync(sourceDir, tempDir, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
    });

    if (fs.existsSync(destinationDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (skillFileContentsMatch(sourceDir, destinationDir)) return;
      log.warn(
        { destinationDir, sourceDir },
        "Skipping nested indexed skill preservation because destination appeared during copy",
      );
      return;
    }

    fs.renameSync(tempDir, destinationDir);
    log.info(
      { destinationDir, sourceDir },
      "Preserved nested indexed skill at top-level skills directory",
    );
  } catch (err) {
    if (isNotFoundError(err)) return;
    log.warn(
      { err, relativeSkillDir, sourceDir, destinationDir },
      "Failed to preserve nested indexed skill",
    );
    throw err;
  }
}

function preserveNestedIndexedSkills(
  workspaceDir: string,
  skillsDir: string,
  indexPath: string,
): void {
  const contents = fs.readFileSync(indexPath, "utf-8");
  const tempRootDir = join(
    workspaceDir,
    ".workspace-migration-084-remove-legacy-skills-index",
  );
  for (const relativeSkillDir of parseLegacySkillIndexEntries(contents)) {
    preserveNestedIndexedSkill(tempRootDir, skillsDir, relativeSkillDir);
  }
  if (fs.existsSync(tempRootDir)) {
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  }
}

export const removeLegacySkillsIndexMigration: WorkspaceMigration = {
  id: "084-remove-legacy-skills-index",
  description: "Remove legacy workspace skills/SKILLS.md index file",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    const indexPath = join(skillsDir, "SKILLS.md");

    try {
      const stat = fs.lstatSync(indexPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        log.warn(
          { path: indexPath },
          "Legacy SKILLS.md path is not a file; leaving it in place",
        );
        return;
      }

      if (stat.isFile()) {
        preserveNestedIndexedSkills(workspaceDir, skillsDir, indexPath);
      }

      fs.unlinkSync(indexPath);
      log.info({ path: indexPath }, "Removed legacy skills index file");
    } catch (err) {
      if (isNotFoundError(err)) return;
      log.warn(
        { err, path: indexPath },
        "Failed to remove legacy skills index file",
      );
      throw err;
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: SKILLS.md is no longer a supported skill catalog format.
  },
};
