import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { deleteSkillCapabilityNode } from "../memory/graph/capability-seed.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { writeInstallMeta } from "./install-meta.js";

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

function getManagedSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

function getManagedSkillDir(id: string): string {
  return join(getManagedSkillsDir(), id);
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

// ─── Version metadata ─────────────────────────────────────────────────────────

function getVersionMetaPath(id: string): string {
  return join(getManagedSkillDir(id), "version.json");
}

// ─── Create / Delete ─────────────────────────────────────────────────────────

interface CreateManagedSkillParams {
  id: string;
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  overwrite?: boolean;
  includes?: string[];
  version?: string;
  contactId?: string;
}

interface CreateManagedSkillResult {
  created: boolean;
  path: string;
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
      error: validationError,
    };
  }

  if (!params.name || !params.name.trim()) {
    return {
      created: false,
      path: "",
      error: "name is required",
    };
  }
  if (!params.description || !params.description.trim()) {
    return {
      created: false,
      path: "",
      error: "description is required",
    };
  }

  const skillDir = getManagedSkillDir(params.id);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !params.overwrite) {
    return {
      created: false,
      path: skillFilePath,
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

  // Write install metadata
  writeInstallMeta(skillDir, {
    origin: "custom",
    installedAt: new Date().toISOString(),
    ...(params.version ? { version: params.version } : {}),
    ...(params.contactId ? { installedBy: params.contactId } : {}),
  });

  // Clean up legacy version.json if present (superseded by install-meta.json)
  const metaPath = getVersionMetaPath(params.id);
  if (existsSync(metaPath)) {
    rmSync(metaPath);
  }

  log.info(
    { id: params.id, path: skillFilePath, version: params.version },
    "Created managed skill",
  );

  return { created: true, path: skillFilePath };
}

interface DeleteManagedSkillResult {
  deleted: boolean;
  error?: string;
}

export function deleteManagedSkill(id: string): DeleteManagedSkillResult {
  const validationError = validateManagedSkillId(id);
  if (validationError) {
    return { deleted: false, error: validationError };
  }

  const skillDir = getManagedSkillDir(id);
  if (!existsSync(skillDir)) {
    return {
      deleted: false,
      error: `Managed skill "${id}" not found`,
    };
  }

  rmSync(skillDir, { recursive: true });
  deleteSkillCapabilityNode(id);
  log.info({ id, path: skillDir }, "Deleted managed skill");

  return { deleted: true };
}
