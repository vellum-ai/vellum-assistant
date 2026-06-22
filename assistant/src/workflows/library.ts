/**
 * Saved-workflow LIBRARY — named workflows the assistant can invoke by name and
 * the scheduler can trigger.
 *
 * Saved workflows live at `<workspace>/workflows/*.workflow.ts`. Each file is a
 * normal workflow script: a leading literal `export const meta = { name,
 * description }` followed by the script body. The library only reads the STATIC
 * `meta` (via {@link extractWorkflowMeta}, a pure-literal extractor that never
 * executes the untrusted source — only the QuickJS sandbox may run it) and the
 * raw source. Resolution to an actual run goes through {@link executeWorkflow} /
 * {@link WorkflowRunManager}, which run the source in the sandbox.
 *
 * The directory is read lazily and is NOT created eagerly: if it does not exist,
 * {@link listWorkflows} returns `[]` and {@link getWorkflow} returns `null`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { extractWorkflowMeta } from "./engine.js";

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

/** The filename (sans `.workflow.ts`) for `<workspace>/workflows/<base>.workflow.ts`. */
function fileBaseName(file: string): string {
  return file.slice(0, -WORKFLOW_SUFFIX.length);
}

/** A `*.workflow.ts` file read off disk, before meta extraction. */
interface RawWorkflowFile {
  file: string;
  path: string;
  source: string;
}

/**
 * Yield every readable `*.workflow.ts` file in the workflows directory (each read
 * once). Returns nothing if the directory does not exist — it is never created.
 * An unreadable file is skipped with a logged warning.
 */
function* readWorkflowFiles(): Generator<RawWorkflowFile> {
  const dir = workflowsDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(WORKFLOW_SUFFIX)) continue;
    const path = join(dir, file);
    try {
      yield { file, path, source: readFileSync(path, "utf8") };
    } catch (err) {
      log.warn({ err, path }, "Failed to read saved workflow; skipping");
    }
  }
}

/**
 * List every saved workflow with a statically-extractable `meta`. A file whose
 * `meta` cannot be statically extracted (computed/missing/malformed) is SKIPPED
 * with a logged warning rather than failing the whole listing.
 */
export function listWorkflows(): SavedWorkflowEntry[] {
  const entries: SavedWorkflowEntry[] = [];
  for (const { path, source } of readWorkflowFiles()) {
    try {
      const meta = extractWorkflowMeta(source);
      entries.push({ name: meta.name, description: meta.description, path });
    } catch (err) {
      log.warn(
        { err, path },
        "Saved workflow has no statically-extractable meta; skipping",
      );
    }
  }
  return entries;
}

/**
 * Resolve a saved workflow by name. Matches against the workflow's `meta.name`
 * first, then falls back to the filename base (`<base>.workflow.ts`). Returns the
 * source + path, or `null` if no saved workflow matches.
 */
export function getWorkflow(name: string): SavedWorkflowSource | null {
  let fileMatch: SavedWorkflowSource | null = null;
  for (const { file, path, source } of readWorkflowFiles()) {
    // Prefer a `meta.name` match — it is the canonical identity.
    try {
      if (extractWorkflowMeta(source).name === name) return { source, path };
    } catch {
      // Fall through: a file with non-extractable meta can still match by name.
    }
    // Remember the first filename-base match as a fallback.
    if (fileMatch === null && fileBaseName(file) === name) {
      fileMatch = { source, path };
    }
  }
  return fileMatch;
}
