import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { deleteSkillCapabilityNode } from "../plugins/defaults/memory/graph/capability-seed.js";
import { isDeniedBasename } from "../tools/shared/filesystem/path-policy.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, getWorkspaceSkillsDir } from "../util/platform.js";
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

/**
 * Size cap for `copy_from` companion sources. Companion files are instructions
 * and scripts, not data assets — a source past this size is almost certainly
 * the wrong file.
 */
export const MAX_COMPANION_SOURCE_BYTES = 1024 * 1024;

/**
 * Validate a `copy_from` companion source and return its contents.
 *
 * The scaffold's `files` input is the only write path available to the
 * retrospective fork (it has no shell), so the same call is the only sanctioned
 * read of an on-disk source. The source must be an absolute path to a regular
 * file whose real path (symlinks resolved) lives under the workspace or the
 * system temp dir — the two places conversation-produced scripts land. That
 * boundary keeps an unattended, prompt-injectable pass from lifting arbitrary
 * host files (dotfiles, keys) into a skill folder the model will later read.
 *
 * Contents are read here, at validation time, so the caller's write loop stays
 * a single all-or-nothing pass over pre-resolved content.
 */
export function validateCompanionSource(
  sourcePath: string,
  opts: { tmpOnly?: boolean } = {},
): {
  content?: string;
  error?: string;
} {
  if (!sourcePath || typeof sourcePath !== "string") {
    return { error: "copy_from source path is required" };
  }
  if (!isAbsolute(sourcePath)) {
    return {
      error: `copy_from source must be an absolute path: "${sourcePath}"`,
    };
  }
  let realSource: string;
  try {
    realSource = realpathSync(sourcePath);
  } catch {
    return { error: `copy_from source does not exist: "${sourcePath}"` };
  }
  // Shared filesystem denylist (path-policy.ts): key-material basenames are
  // unreadable even inside the workspace boundary, so a copy must not become a
  // side door. Check both the submitted path and its realpath so neither a
  // direct name nor a symlink to a denied name slips through.
  if (isDeniedBasename(sourcePath) || isDeniedBasename(realSource)) {
    return {
      error: `copy_from source is a denied filename: "${sourcePath}"`,
    };
  }
  // Literal /tmp is allowed alongside os.tmpdir(): on macOS tmpdir() is the
  // per-user /var/folders/... path, but the documented snippet-testing
  // workflow (and the retrospective prompt) use /tmp, which realpaths to
  // /private/tmp there.
  //
  // tmpOnly explicitly denies workspace sources before the temp-root
  // allowlist is consulted: a workspace configured under os.tmpdir() (or
  // /tmp) would otherwise leave every workspace file reachable through the
  // temp roots, defeating the no-workspace-reads restriction.
  if (opts.tmpOnly) {
    let realWorkspace = getWorkspaceDir();
    try {
      realWorkspace = realpathSync(realWorkspace);
    } catch {
      // Missing workspace dir: nothing can resolve under it.
    }
    const relToWorkspace = relative(realWorkspace, realSource);
    if (
      relToWorkspace === "" ||
      (!relToWorkspace.startsWith("..") && !isAbsolute(relToWorkspace))
    ) {
      return {
        error: `copy_from source must live under the system temp dir for retrospective scaffolds: "${sourcePath}"`,
      };
    }
  }
  // tmpOnly drops the workspace root. The unattended retrospective runs over
  // prompt-injectable content with scaffold_managed_skill auto-granted, so a
  // workspace-wide read would let an injected pass persist unrelated
  // user/assistant state (other skills, persona files, user documents) into a
  // skill folder. Restricting it to the temp roots keeps copy_from usable for
  // tested snippets while giving the unattended pass zero workspace reads —
  // workspace-resident code still travels via inline `content`, which the
  // model already holds in its trace.
  const allowedRoots = [
    ...(opts.tmpOnly ? [] : [getWorkspaceDir()]),
    tmpdir(),
    "/tmp",
  ].map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  const underAllowedRoot = allowedRoots.some((root) => {
    const rel = relative(root, realSource);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!underAllowedRoot) {
    return {
      error: opts.tmpOnly
        ? `copy_from source must live under the system temp dir for retrospective scaffolds: "${sourcePath}"`
        : `copy_from source must live under the workspace or the system temp dir: "${sourcePath}"`,
    };
  }
  const stat = statSync(realSource);
  if (!stat.isFile()) {
    return { error: `copy_from source is not a regular file: "${sourcePath}"` };
  }
  if (stat.size > MAX_COMPANION_SOURCE_BYTES) {
    return {
      error: `copy_from source exceeds ${MAX_COMPANION_SOURCE_BYTES} bytes: "${sourcePath}"`,
    };
  }
  return { content: readFileSync(realSource, "utf-8") };
}

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
  // Conversation lineage for retrospective-authored skills — see the field
  // docs on `SkillInstallMeta` (install-meta.ts).
  sourceConversationId?: string;
  retrospectiveConversationId?: string;
  // Exactly one of `content` (inline) or `copyFrom` (validated on-disk source)
  // per entry — enforced in the pre-write validation loop.
  files?: Array<{ path: string; content?: string; copyFrom?: string }>;
  // Restrict copyFrom sources to the temp roots (no workspace reads). Set for
  // unattended retrospective scaffolds — see validateCompanionSource.
  restrictCopySourcesToTmp?: boolean;
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
    if ((file.content === undefined) === (file.copyFrom === undefined)) {
      return {
        created: false,
        path: skillFilePath,
        error: `companion file "${file.path}" must set exactly one of content or copy_from`,
      };
    }
    let content: string;
    if (file.copyFrom !== undefined) {
      const source = validateCompanionSource(file.copyFrom, {
        tmpOnly: params.restrictCopySourcesToTmp === true,
      });
      if (source.error || source.content === undefined) {
        return {
          created: false,
          path: skillFilePath,
          error: source.error ?? "invalid copy_from source",
        };
      }
      content = source.content;
    } else {
      content = file.content as string;
    }
    companionWrites.push({ resolvedPath, content });
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
    ...(params.sourceConversationId
      ? { sourceConversationId: params.sourceConversationId }
      : {}),
    ...(params.retrospectiveConversationId
      ? { retrospectiveConversationId: params.retrospectiveConversationId }
      : {}),
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
