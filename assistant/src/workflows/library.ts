/**
 * Saved-workflow LIBRARY — named workflows the assistant can invoke by name and
 * the scheduler can trigger.
 *
 * Saved workflows live at `<workspace>/workflows/`. The preferred layout is
 * directory-style `<name>/workflow.ts` (so a workflow and its state can sit in
 * one folder); flat `<name>.workflow.ts` is still supported but discouraged. On
 * a base-name collision the directory wins. Each is a normal workflow script: a
 * leading literal
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
import { getWorkspaceDir } from "../util/platform.js";
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

/** Absolute path to the saved-workflows directory (`<workspace>/workflows`). */
function workflowsDir(): string {
  return join(getWorkspaceDir(), "workflows");
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

/**
 * Yield every readable saved workflow in a STABLE order (the raw filesystem
 * listing order is not guaranteed, so callers that take "the first match" stay
 * deterministic). Directory-style `<name>/workflow.ts` is yielded first and
 * WINS: a flat `<name>.workflow.ts` with the same base name is shadowed (skipped
 * with a warning). Yields nothing if the directory does not exist — it is never
 * created. An unreadable entry is skipped with a logged warning.
 */
function* readWorkflowFiles(): Generator<RawWorkflowFile> {
  const dir = workflowsDir();
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).sort();
  const seen = new Set<string>();

  // Directory-style first, so it wins over a same-base-name flat file.
  for (const entry of entries) {
    if (entry.endsWith(WORKFLOW_SUFFIX)) continue;
    const path = join(dir, entry, DIRECTORY_ENTRY);
    if (!existsSync(path)) continue;
    try {
      const source = readFileSync(path, "utf8");
      seen.add(entry);
      yield { baseName: entry, path, source };
    } catch (err) {
      log.warn({ err, path }, "Failed to read saved workflow; skipping");
    }
  }

  // Flat files second; skip any shadowed by a directory of the same base name.
  for (const entry of entries) {
    if (!entry.endsWith(WORKFLOW_SUFFIX)) continue;
    const baseName = fileBaseName(entry);
    const path = join(dir, entry);
    if (seen.has(baseName)) {
      log.warn(
        { path },
        `Flat workflow "${entry}" is shadowed by directory "${baseName}/"; skipping`,
      );
      continue;
    }
    try {
      const source = readFileSync(path, "utf8");
      seen.add(baseName);
      yield { baseName, path, source };
    } catch (err) {
      log.warn({ err, path }, "Failed to read saved workflow; skipping");
    }
  }
}

/**
 * List every saved workflow with a statically-extractable `meta`, deduplicated
 * by `meta.name` — the first in {@link readWorkflowFiles}' stable order wins, a
 * later duplicate is skipped with a warning (matching {@link getWorkflow}'s
 * winner). A file whose `meta` cannot be statically extracted is skipped with a
 * warning rather than failing the whole listing.
 */
export function listWorkflows(): SavedWorkflowEntry[] {
  const entries: SavedWorkflowEntry[] = [];
  const seenNames = new Set<string>();
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
    if (seenNames.has(meta.name)) {
      log.warn(
        { path, name: meta.name },
        `Duplicate workflow name "${meta.name}"; skipping shadowed entry`,
      );
      continue;
    }
    seenNames.add(meta.name);
    entries.push({ name: meta.name, description: meta.description, path });
  }
  return entries;
}

/**
 * Resolve a saved workflow by name, deterministically — {@link readWorkflowFiles}
 * yields in a stable order with directory-over-flat precedence, so "the first
 * match" is well-defined. Matches `meta.name` first (the canonical identity),
 * then falls back to the base name (directory or flat-file). Returns the source
 * + path, or `null` if nothing matches.
 */
export function getWorkflow(name: string): SavedWorkflowSource | null {
  let fileMatch: SavedWorkflowSource | null = null;
  for (const { baseName, path, source } of readWorkflowFiles()) {
    // Prefer a `meta.name` match — it is the canonical identity.
    try {
      if (extractWorkflowMeta(source).name === name) return { source, path };
    } catch {
      // Fall through: a file with non-extractable meta can still match by name.
    }
    // Remember the first base-name match as a fallback.
    if (fileMatch === null && baseName === name) {
      fileMatch = { source, path };
    }
  }
  return fileMatch;
}
