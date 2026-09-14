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

import { parseFrontmatter } from "../config/skills.js";
import { deleteSkillCapabilityNode } from "../plugins/defaults/memory/graph/capability-seed.js";
import { isDeniedBasename } from "../tools/shared/filesystem/path-policy.js";
import { getLogger } from "../util/logger.js";
import { isPlainObject } from "../util/object.js";
import { getWorkspaceDir, getWorkspaceSkillsDir } from "../util/platform.js";
import { parseFrontmatterFields } from "./frontmatter.js";
import { writeInstallMeta } from "./install-meta.js";

const log = getLogger("managed-store");

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function validateManagedSkillId(id: string): string | null {
  if (!id || typeof id !== "string") {
    return "skill_id is required";
  }
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
export function validateCompanionSource(sourcePath: string): {
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
  const allowedRoots = [getWorkspaceDir(), tmpdir(), "/tmp"].map((root) => {
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
      error: `copy_from source must live under the workspace or the system temp dir: "${sourcePath}"`,
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
  /**
   * The five fields the scaffold tool owns. `undefined` leaves whatever
   * `preserve` carries for that field (nothing, on a create); an empty value
   * clears it; a value sets it.
   */
  emoji?: string;
  includes?: string[];
  activationHints?: string[];
  avoidWhen?: string[];
  category?: string;
  /**
   * The skill's existing frontmatter, as parsed from disk, for an overwrite.
   * Every key survives except `name`, `description`, and the five fields
   * above, so a `platforms` gate, a `display-name`, or custom metadata a
   * person added by hand is not lost to a call that never mentions it.
   */
  preserve?: Record<string, unknown>;
}

/**
 * Apply one tool-owned field to the vellum block: an input left `undefined`
 * keeps the preserved value, an input given but empty (`value` undefined)
 * clears it, and a value sets it.
 */
function setOrClear(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  input: unknown,
): void {
  if (input === undefined) {
    return;
  }
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

function nonEmptyList(list: string[] | undefined): string[] | undefined {
  return list && list.length > 0 ? list : undefined;
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

  // Everything but name and description is emitted from one object: the
  // preserved frontmatter with the tool-owned fields applied over it, under
  // `metadata.vellum` where parseFrontmatter reads them back (kebab-case for
  // the two list fields). stringifyYaml quotes and escapes values, so no
  // manual sanitization is needed here.
  const rest: Record<string, unknown> = structuredClone(input.preserve ?? {});
  delete rest.name;
  delete rest.description;
  const metadata = isPlainObject(rest.metadata) ? rest.metadata : {};
  const vellum = isPlainObject(metadata.vellum) ? metadata.vellum : {};
  setOrClear(vellum, "emoji", input.emoji?.trim() || undefined, input.emoji);
  // An emoji at the legacy `metadata.emoji` location wins over an absent
  // vellum one on read, so a call that states the emoji retires it.
  if (input.emoji !== undefined) {
    delete metadata.emoji;
  }
  setOrClear(vellum, "includes", nonEmptyList(input.includes), input.includes);
  setOrClear(
    vellum,
    "activation-hints",
    nonEmptyList(input.activationHints),
    input.activationHints,
  );
  setOrClear(
    vellum,
    "avoid-when",
    nonEmptyList(input.avoidWhen),
    input.avoidWhen,
  );
  // The web Skills UI buckets skills by this value; a blank one is a clear,
  // never an empty bucket in the file.
  setOrClear(
    vellum,
    "category",
    input.category?.trim() || undefined,
    input.category,
  );
  if (Object.keys(vellum).length > 0) {
    metadata.vellum = vellum;
  } else {
    delete metadata.vellum;
  }
  if (Object.keys(metadata).length > 0) {
    rest.metadata = metadata;
  } else {
    delete rest.metadata;
  }
  if (Object.keys(rest).length > 0) {
    lines.push(stringifyYaml(rest, { indent: 2 }).trimEnd());
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

  const skillExists = existsSync(skillFilePath);
  if (skillExists && !params.overwrite) {
    return {
      created: false,
      path: skillFilePath,
      error: `Managed skill "${params.id}" already exists. Set overwrite=true to replace it.`,
    };
  }

  // An overwrite replaces the body and patches the frontmatter: a field the
  // call leaves undefined keeps its current value, an explicit empty value
  // clears it, and frontmatter the tool does not own passes through. Callers
  // rarely hold every field (the retrospective sees a skill through a
  // similarity hit; a user edit is "change step 3"), so a field they do not
  // pass is kept rather than dropped.
  const existing = skillExists ? readStoredManagedSkill(params.id) : null;

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
      const source = validateCompanionSource(file.copyFrom);
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
    preserve: existing?.frontmatter,
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

/**
 * A managed skill as it is on disk. Frontmatter fields come through the
 * catalog's parser so they are exactly what routing and the Skills UI see;
 * `body` is the stored text after the frontmatter, verbatim except for the
 * separator newline the store writes before it and the trailing newline it
 * guarantees. Verbatim matters: the skill loader substitutes `{baseDir}` and
 * `{workspaceDir}` and strips feature-gated sections, and a caller that wrote
 * that output back would bake absolute paths into the skill; and a first line
 * that opens an indented code block must keep its indentation or a copy turns
 * it into prose. `frontmatter` is the whole block as written, for an
 * overwrite to carry keys through that the typed fields do not cover.
 */
export interface StoredManagedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  emoji?: string;
  includes?: string[];
  activationHints?: string[];
  avoidWhen?: string[];
  category?: string;
  body: string;
}

/**
 * Read a managed skill from disk. Best-effort: a missing file or frontmatter
 * that does not parse resolves to null, so a caller enriching or patching one
 * skill never fails on a bad one.
 */
export function readStoredManagedSkill(
  skillId: string,
): StoredManagedSkill | null {
  const skillFilePath = join(getManagedSkillDir(skillId), "SKILL.md");
  try {
    const content = readFileSync(skillFilePath, "utf-8");
    const parsed = parseFrontmatter(content, skillFilePath);
    const raw = parseFrontmatterFields(content);
    if (!parsed || !raw) {
      return null;
    }
    return {
      name: parsed.name,
      description: parsed.description,
      frontmatter: raw.fields,
      emoji: parsed.emoji,
      includes: parsed.includes,
      activationHints: parsed.activationHints,
      avoidWhen: parsed.avoidWhen,
      category: parsed.category,
      body: raw.body.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, ""),
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, "Could not read managed skill");
    return null;
  }
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
