import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { deleteSkillCapabilityNode } from "../plugins/defaults/memory/graph/capability-seed.js";
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

/** Absolute path of a managed skill's directory (whether or not it exists). */
export function getManagedSkillDir(id: string): string {
  return join(getManagedSkillsDir(), id);
}

interface ResolvedCompanionPath {
  resolvedPath?: string;
  error?: string;
}

/**
 * Validate a companion file path and resolve it under the skill directory.
 * Rejects absolute paths, `..` segments, and any path that resolves outside
 * the skill dir. Returns the resolved absolute path or an error.
 */
export function validateCompanionPath(
  skillDir: string,
  filePath: string,
): ResolvedCompanionPath {
  if (!filePath || typeof filePath !== "string") {
    return { error: "companion file path is required" };
  }
  if (isAbsolute(filePath)) {
    return { error: `companion file path must be relative: "${filePath}"` };
  }
  const normalized = normalize(filePath);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split(sep).includes("..")
  ) {
    return {
      error: `companion file path must not contain ".." segments: "${filePath}"`,
    };
  }
  const resolvedPath = join(skillDir, normalized);
  const rel = relative(skillDir, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return {
      error: `companion file path must resolve under the skill directory: "${filePath}"`,
    };
  }
  // A companion write must never target a top-level store-owned file: SKILL.md
  // is the discovery entry point (generated from name/description/body), the
  // metadata files carry provenance the store owns, and TOOLS.json is reserved
  // because it is the manifest that registers executable skill tools. Allowing a
  // scaffold companion write to plant a TOOLS.json would let an author (the
  // memory retrospective runs unattended over prompt-injectable content) turn an
  // instruction-only managed skill into one that registers — and dynamically
  // imports — attacker-controlled executors, a code-injection surface. Managed
  // skills authored via scaffold carry instructions and reference files only;
  // executable tools are a first-party/bundled concept.
  //
  // The comparison is case-insensitive. The install target includes
  // case-insensitive filesystems (macOS APFS/HFS+ default), where a companion
  // written as `tools.json` / `Tools.json` resolves to the very file the
  // manifest scanner later reads as `TOOLS.json` (and likewise for `skill.md`).
  // An exact-case check would let a varied-case name slip a manifest past this
  // guard, so lowercase the candidate before testing membership.
  if (RESERVED_COMPANION_NAMES.has(rel.replaceAll(sep, "/").toLowerCase())) {
    return {
      error: `companion file path must not overwrite the store-owned file: "${filePath}"`,
    };
  }
  return { resolvedPath };
}

/**
 * Top-level files owned by the store; companion writes may never target them.
 * Entries are lowercase — the membership check lowercases the candidate path so
 * case variants (e.g. `tools.json`) are rejected on case-insensitive filesystems.
 */
const RESERVED_COMPANION_NAMES = new Set([
  "skill.md",
  "install-meta.json",
  "version.json",
  "tools.json",
]);

// ─── SKILL.md generation ─────────────────────────────────────────────────────

interface BuildSkillMarkdownInput {
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  includes?: string[];
  activationHints?: string[];
  avoidWhen?: string[];
  category?: string;
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
  // Kebab-case keys match what parseFrontmatter reads back
  // (config/skills.ts: vellum["activation-hints"] / vellum["avoid-when"]).
  // These flow through stringifyYaml below, which escapes/quotes values, so no
  // manual sanitization is needed here.
  if (input.activationHints && input.activationHints.length > 0) {
    vellum["activation-hints"] = input.activationHints;
  }
  if (input.avoidWhen && input.avoidWhen.length > 0) {
    vellum["avoid-when"] = input.avoidWhen;
  }
  // The web Skills UI groups skills into a category sidebar by this value;
  // skip it when blank so an empty bucket assignment never lands in frontmatter.
  if (input.category?.trim()) {
    vellum.category = input.category.trim();
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
  activationHints?: string[];
  avoidWhen?: string[];
  category?: string;
  version?: string;
  contactId?: string;
  author?: "assistant" | "user";
  files?: Array<{ path: string; content: string }>;
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

  // Resolve and validate every companion path before any write so an invalid
  // path leaves no partial files behind.
  const companionWrites: Array<{ resolvedPath: string; content: string }> = [];
  for (const file of params.files ?? []) {
    const { resolvedPath, error } = validateCompanionPath(skillDir, file.path);
    if (error || !resolvedPath) {
      return {
        created: false,
        path: skillFilePath,
        error: error ?? "invalid companion file path",
      };
    }
    // Reject a companion path that resolves to an existing directory before any
    // write: the atomic rename would throw mid-loop (after SKILL.md is already
    // rewritten on overwrite), leaving a half-updated skill.
    if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
      return {
        created: false,
        path: skillFilePath,
        error: `companion file path resolves to an existing directory: "${file.path}"`,
      };
    }
    companionWrites.push({ resolvedPath, content: file.content });
  }

  const content = buildSkillMarkdown({
    name: params.name,
    description: params.description,
    bodyMarkdown: params.bodyMarkdown,
    emoji: params.emoji,
    includes: params.includes,
    activationHints: params.activationHints,
    avoidWhen: params.avoidWhen,
    category: params.category,
  });

  mkdirSync(skillDir, { recursive: true });
  atomicWriteFile(skillFilePath, content);

  for (const { resolvedPath, content: fileContent } of companionWrites) {
    mkdirSync(dirname(resolvedPath), { recursive: true });
    atomicWriteFile(resolvedPath, fileContent);
  }

  // Write install metadata
  writeInstallMeta(skillDir, {
    origin: "custom",
    installedAt: new Date().toISOString(),
    ...(params.version ? { version: params.version } : {}),
    ...(params.contactId ? { installedBy: params.contactId } : {}),
    ...(params.author ? { author: params.author } : {}),
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
