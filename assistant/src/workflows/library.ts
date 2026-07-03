/**
 * Saved-workflow LIBRARY — named workflows the assistant can invoke by name and
 * the scheduler can trigger.
 *
 * Saved workflows live at `<workspace>/workflows/`. The preferred layout is
 * directory-style `<name>/workflow.ts` (so a workflow and its state can sit in
 * one folder); flat `<name>.workflow.ts` is still supported but discouraged. A
 * base-name collision or a duplicate `meta.name` FAILS CLOSED — the ambiguous
 * name resolves to nothing, so a planted file can't shadow a trusted workflow.
 * Each is a normal workflow script: a leading literal
 * `export const meta = { name, description }` followed by the script body. The
 * library only reads the STATIC `meta` (via {@link extractWorkflowMeta}, a
 * pure-literal extractor that never executes the untrusted source — only the
 * QuickJS sandbox may run it) and the raw source. Resolution to an actual run
 * goes through {@link executeWorkflow} / {@link WorkflowRunManager}, which run
 * the source in the sandbox.
 *
 * The directory is read lazily and is NOT created eagerly: if it does not exist,
 * {@link listWorkflows} returns `[]` and {@link getWorkflow} returns `null`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceWorkflowsDir } from "../util/platform.js";
import { extractWorkflowMeta, type WorkflowMeta } from "./engine.js";

const log = getLogger("workflow-library");

/** File suffix every saved workflow uses. */
const WORKFLOW_SUFFIX = ".workflow.ts";

/** A saved workflow surfaced by {@link listWorkflows}. */
export interface SavedWorkflowEntry {
  /** The workflow's `meta.name`. */
  name: string;
  /** The workflow's `meta.description`. */
  description: string;
  /** Absolute path to the `*.workflow.ts` file. */
  path: string;
}

/** The source + path of a resolved saved workflow. */
export interface SavedWorkflowSource {
  /** The raw script source (TS). */
  source: string;
  /** Absolute path to the `*.workflow.ts` file. */
  path: string;
}

/** Filename of the entry-point script inside a directory-style workflow. */
const DIRECTORY_ENTRY = "workflow.ts";

/** The filename (sans `.workflow.ts`) for `<workspace>/workflows/<base>.workflow.ts`. */
function fileBaseName(file: string): string {
  return file.slice(0, -WORKFLOW_SUFFIX.length);
}

/** A saved workflow read off disk, before meta extraction. */
interface RawWorkflowFile {
  /** Base identity for the filename/dir fallback match (see {@link getWorkflow}). */
  baseName: string;
  path: string;
  source: string;
}

/** Read one saved workflow off disk; `null` (with a warning) if unreadable. */
function readRawWorkflow(
  baseName: string,
  path: string,
): RawWorkflowFile | null {
  try {
    return { baseName, path, source: readFileSync(path, "utf8") };
  } catch (err) {
    log.warn({ err, path }, "Failed to read saved workflow; skipping");
    return null;
  }
}

/** Log the fail-closed refusal to resolve a name declared by multiple files. */
function logDuplicateMetaName(name: string, paths: string[]): void {
  log.error(
    { name, paths },
    `Multiple saved workflows declare meta.name "${name}"; resolving none. ` +
      `Delete or rename all but one to disambiguate.`,
  );
}

/**
 * Yield every readable saved workflow in a STABLE order (sorted, so "the first
 * match" is deterministic). Directory-style `<name>/workflow.ts` is yielded
 * before flat `<name>.workflow.ts`.
 *
 * FAIL CLOSED on a base-name collision: if a base name exists as BOTH a
 * directory and a flat file, neither is yielded — otherwise a planted
 * `<name>/workflow.ts` could silently shadow a trusted flat workflow.
 *
 * Yields nothing if the directory does not exist. An unreadable entry is
 * skipped with a logged warning.
 */
function* readWorkflowFiles(): Generator<RawWorkflowFile> {
  const dir = getWorkspaceWorkflowsDir();
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).sort();

  // Resolve each form once, keyed by base name (sorted entries keep Map
  // iteration deterministic).
  const dirPaths = new Map<string, string>();
  const flatPaths = new Map<string, string>();
  for (const entry of entries) {
    if (entry.endsWith(WORKFLOW_SUFFIX)) {
      flatPaths.set(fileBaseName(entry), join(dir, entry));
      continue;
    }
    const entrypoint = join(dir, entry, DIRECTORY_ENTRY);
    if (existsSync(entrypoint)) dirPaths.set(entry, entrypoint);
  }

  // Fail closed on a base-name collision (both forms present).
  const collisions = new Set<string>();
  for (const baseName of dirPaths.keys()) {
    if (flatPaths.has(baseName)) collisions.add(baseName);
  }
  for (const baseName of collisions) {
    log.error(
      { dir, baseName },
      `Saved workflow "${baseName}" exists as BOTH a directory "${baseName}/" and ` +
        `a flat file "${baseName}${WORKFLOW_SUFFIX}"; resolving neither. Delete one to disambiguate.`,
    );
  }

  // Directory-style first, then flat; a colliding base name is skipped in both.
  for (const [baseName, path] of [...dirPaths, ...flatPaths]) {
    if (collisions.has(baseName)) continue;
    const raw = readRawWorkflow(baseName, path);
    if (raw) yield raw;
  }
}

/**
 * List every saved workflow with a statically-extractable `meta` (a file whose
 * `meta` can't be extracted is skipped, not fatal).
 *
 * FAIL CLOSED on a duplicate `meta.name`: if two files declare the same name,
 * neither is listed — matching {@link getWorkflow}, so a planted file can't
 * hijack the name by iteration order.
 */
export function listWorkflows(): SavedWorkflowEntry[] {
  // Group by meta.name so a duplicate can drop all sharers (fail closed).
  const byName = new Map<string, SavedWorkflowEntry[]>();
  for (const { path, source } of readWorkflowFiles()) {
    let meta: WorkflowMeta;
    try {
      meta = extractWorkflowMeta(source);
    } catch (err) {
      log.warn(
        { err, path },
        "Saved workflow has no statically-extractable meta; skipping",
      );
      continue;
    }
    const group = byName.get(meta.name) ?? [];
    group.push({ name: meta.name, description: meta.description, path });
    byName.set(meta.name, group);
  }

  const entries: SavedWorkflowEntry[] = [];
  for (const [name, group] of byName) {
    if (group.length > 1) {
      logDuplicateMetaName(
        name,
        group.map((e) => e.path),
      );
      continue;
    }
    entries.push(group[0]);
  }
  return entries;
}

/**
 * Resolve a saved workflow by name: `meta.name` first (canonical), then the
 * base name (directory or flat file). Returns the source + path, or `null`.
 *
 * FAIL CLOSED on a duplicate `meta.name`: if two files declare the requested
 * name, neither is returned, so a planted file can't hijack it by iteration
 * order. Base-name collisions already fail closed in {@link readWorkflowFiles}.
 */
export function getWorkflow(name: string): SavedWorkflowSource | null {
  const nameMatches: SavedWorkflowSource[] = [];
  let fileMatch: SavedWorkflowSource | null = null;
  for (const { baseName, path, source } of readWorkflowFiles()) {
    // Prefer a `meta.name` match — it is the canonical identity.
    try {
      if (extractWorkflowMeta(source).name === name) {
        nameMatches.push({ source, path });
        continue;
      }
    } catch {
      // Fall through: a file with non-extractable meta can still match by name.
    }
    // Remember the first base-name match as a fallback.
    if (fileMatch === null && baseName === name) {
      fileMatch = { source, path };
    }
  }

  if (nameMatches.length > 1) {
    logDuplicateMetaName(
      name,
      nameMatches.map((m) => m.path),
    );
    return null;
  }
  return nameMatches[0] ?? fileMatch;
}
