import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { deleteSkillCapabilityMemory } from "./skill-memory.js";

const log = getLogger("managed-store");

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function validateManagedSkillId(id: string): string | null {
  if (!id || typeof id !== "string") return "skill_id is required";
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    return "skill_id must not contain path traversal characters";
  }
  if (!VALID_SKILL_ID.test(id)) {
    return "skill_id must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, and underscores";
  }
  return null;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export function getManagedSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

export function getManagedSkillDir(id: string): string {
  return join(getManagedSkillsDir(), id);
}

function getSkillsIndexPath(): string {
  return join(getManagedSkillsDir(), "SKILLS.md");
}

// ─── SKILL.md generation ─────────────────────────────────────────────────────

interface BuildSkillMarkdownInput {
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  includes?: string[];
}

export function buildSkillMarkdown(input: BuildSkillMarkdownInput): string {
  const esc = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  const lines: string[] = ["---"];
  lines.push(`name: "${esc(input.name)}"`);
  lines.push(`description: "${esc(input.description)}"`);

  // Build metadata object matching the format parseFrontmatter expects:
  // metadata:
  //   vellum:
  //     emoji: "..."
  const vellum: Record<string, unknown> = {};
  if (input.emoji) {
    vellum.emoji = input.emoji;
  }
  if (input.includes && input.includes.length > 0) {
    vellum.includes = input.includes;
  }

  if (Object.keys(vellum).length > 0) {
    const metadata = { vellum };
    const yamlBlock = stringifyYaml(metadata, { indent: 2 });
    lines.push("metadata:");
    for (const yamlLine of yamlBlock.trimEnd().split("\n")) {
      lines.push(`  ${yamlLine}`);
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(input.bodyMarkdown);
  // Ensure trailing newline
  const content = lines.join("\n");
  return content.endsWith("\n") ? content : content + "\n";
}

// ─── Atomic write ────────────────────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ─── SKILLS.md index management ──────────────────────────────────────────────

function readIndexLines(): string[] {
  const indexPath = getSkillsIndexPath();
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf-8").split("\n");
}

function writeIndexLines(lines: string[]): void {
  const content = lines.join("\n");
  atomicWriteFile(
    getSkillsIndexPath(),
    content.endsWith("\n") ? content : content + "\n",
  );
}

function indexEntryRegex(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match both - and * bullets, optional backticks, optional markdown link wrapping,
  // and optional /SKILL.md suffix (inside or outside link parens)
  return new RegExp(
    `^[-*]\\s+(?:\`)?(?:\\[.*?\\]\\()?${escaped}(?:/SKILL\\.md)?(?:\\))?(?:\`)?\\s*$`,
  );
}

export function upsertSkillsIndexEntry(id: string): void {
  const lines = readIndexLines();
  const pattern = indexEntryRegex(id);
  if (lines.some((line) => pattern.test(line))) {
    return; // already present
  }
  // Append new entry
  const nonEmpty = lines.filter((l) => l.trim());
  nonEmpty.push(`- ${id}`);
  writeIndexLines(nonEmpty);
  log.info({ id }, "Added managed skill to SKILLS.md index");
}

export function removeSkillsIndexEntry(id: string): void {
  const lines = readIndexLines();
  const pattern = indexEntryRegex(id);
  const filtered = lines.filter((line) => !pattern.test(line));
  if (filtered.length === lines.length) {
    return; // not found
  }
  writeIndexLines(filtered.filter((l) => l.trim()));
  log.info({ id }, "Removed managed skill from SKILLS.md index");
}

// ─── Version metadata ─────────────────────────────────────────────────────────

interface SkillVersionMeta {
  version: string;
  installedAt: string;
}

function getVersionMetaPath(id: string): string {
  return join(getManagedSkillDir(id), "version.json");
}

function writeVersionMeta(id: string, version: string): void {
  const meta: SkillVersionMeta = {
    version,
    installedAt: new Date().toISOString(),
  };
  atomicWriteFile(getVersionMetaPath(id), JSON.stringify(meta, null, 2) + "\n");
}

export function readSkillVersion(id: string): string | null {
  const metaPath = getVersionMetaPath(id);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const meta: SkillVersionMeta = JSON.parse(raw);
    return meta.version ?? null;
  } catch {
    return null;
  }
}

/** Returns the ISO 8601 timestamp when the skill was installed, or null if unavailable. */
export function readSkillInstalledAt(id: string): string | null {
  const metaPath = getVersionMetaPath(id);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const meta: SkillVersionMeta = JSON.parse(raw);
    return meta.installedAt ?? null;
  } catch {
    return null;
  }
}

// ─── Create / Delete ─────────────────────────────────────────────────────────

interface CreateManagedSkillParams {
  id: string;
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  overwrite?: boolean;
  addToIndex?: boolean;
  includes?: string[];
  version?: string;
}

interface CreateManagedSkillResult {
  created: boolean;
  path: string;
  indexUpdated: boolean;
  error?: string;
}

export function createManagedSkill(
  params: CreateManagedSkillParams,
): CreateManagedSkillResult {
  const validationError = validateManagedSkillId(params.id);
  if (validationError) {
    return {
      created: false,
      path: "",
      indexUpdated: false,
      error: validationError,
    };
  }

  if (!params.name || !params.name.trim()) {
    return {
      created: false,
      path: "",
      indexUpdated: false,
      error: "name is required",
    };
  }
  if (!params.description || !params.description.trim()) {
    return {
      created: false,
      path: "",
      indexUpdated: false,
      error: "description is required",
    };
  }

  const skillDir = getManagedSkillDir(params.id);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !params.overwrite) {
    return {
      created: false,
      path: skillFilePath,
      indexUpdated: false,
      error: `Managed skill "${params.id}" already exists. Set overwrite=true to replace it.`,
    };
  }

  const content = buildSkillMarkdown({
    name: params.name,
    description: params.description,
    bodyMarkdown: params.bodyMarkdown,
    emoji: params.emoji,
    includes: params.includes,
  });

  mkdirSync(skillDir, { recursive: true });
  atomicWriteFile(skillFilePath, content);

  if (params.version) {
    writeVersionMeta(params.id, params.version);
  } else {
    // Remove stale version metadata when overwriting without a version
    const metaPath = getVersionMetaPath(params.id);
    if (existsSync(metaPath)) {
      rmSync(metaPath);
    }
  }

  log.info(
    { id: params.id, path: skillFilePath, version: params.version },
    "Created managed skill",
  );

  let indexUpdated = false;
  if (params.addToIndex !== false) {
    upsertSkillsIndexEntry(params.id);
    indexUpdated = true;
  }

  return { created: true, path: skillFilePath, indexUpdated };
}

interface DeleteManagedSkillResult {
  deleted: boolean;
  indexUpdated: boolean;
  error?: string;
}

export function deleteManagedSkill(
  id: string,
  removeFromIndex = true,
): DeleteManagedSkillResult {
  const validationError = validateManagedSkillId(id);
  if (validationError) {
    return { deleted: false, indexUpdated: false, error: validationError };
  }

  const skillDir = getManagedSkillDir(id);
  if (!existsSync(skillDir)) {
    return {
      deleted: false,
      indexUpdated: false,
      error: `Managed skill "${id}" not found`,
    };
  }

  rmSync(skillDir, { recursive: true });
  deleteSkillCapabilityMemory(id);
  log.info({ id, path: skillDir }, "Deleted managed skill");

  let indexUpdated = false;
  if (removeFromIndex) {
    try {
      removeSkillsIndexEntry(id);
      indexUpdated = true;
    } catch (err) {
      // Best-effort: skill dir is already gone, don't fail the whole delete
      log.warn(
        { id, err },
        "Failed to update skills index after deleting managed skill",
      );
    }
  }

  return { deleted: true, indexUpdated };
}
