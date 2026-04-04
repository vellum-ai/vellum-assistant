/**
 * File-based persistence for user-defined apps and their records.
 *
 * Directory layout:
 *   ~/.vellum/apps/
 *     <dirName>.json            # app definition
 *     <dirName>/
 *       records/
 *         <record-id>.json     # individual record
 *
 * `dirName` is a human-readable slug derived from the app name at creation
 * time and frozen thereafter (renaming an app does NOT rename its directory).
 * Pre-migration apps (no `dirName` in JSON) fall back to using `id` (UUID).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { EditEngineResult } from "../tools/shared/filesystem/edit-engine.js";
import { applyEdit } from "../tools/shared/filesystem/edit-engine.js";
import { getDataDir } from "../util/platform.js";

export interface AppDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  preview?: string;
  schemaJson: string;
  htmlDefinition: string;
  version?: string;
  /** Additional pages keyed by filename (e.g. "settings.html" -> HTML content). */
  pages?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** App format version. undefined or 1 = legacy single-HTML, 2 = multi-file TSX. */
  formatVersion?: number;
  /** Filesystem directory/file stem. Frozen at creation -- never changes on rename. */
  dirName?: string;
}

/**
 * Returns true if the app uses the multi-file TSX format (formatVersion 2).
 */
export function isMultifileApp(app: AppDefinition): boolean {
  return app.formatVersion === 2;
}

/**
 * Inline dist assets (main.js, main.css) into the compiled HTML so it can be
 * delivered as a self-contained string via loadHTMLString/SSE without needing
 * the client to resolve external script/stylesheet URLs.
 */
export function inlineDistAssets(appDir: string, html: string): string {
  const distDir = join(appDir, "dist");

  // Inline main.js
  const jsPath = join(distDir, "main.js");
  if (existsSync(jsPath)) {
    const js = readFileSync(jsPath, "utf-8").replace(/<\/script>/g, "<\\/script>");
    html = html.replace(
      /<script\s+type="module"\s+src="main\.js"\s*><\/script>/,
      () => `<script type="module">${js}</script>`,
    );
  }

  // Inline main.css
  const cssPath = join(distDir, "main.css");
  if (existsSync(cssPath)) {
    const css = readFileSync(cssPath, "utf-8");
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="main\.css"\s*>/,
      () => `<style>${css}</style>`,
    );
  }

  return html;
}

export interface AppRecord {
  id: string;
  appId: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function validateId(id: string): void {
  if (
    !id ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    id !== id.trim()
  ) {
    throw new Error(`Invalid ID: ${id}`);
  }
}

/**
 * Validate a dirName read from persisted JSON.
 * Superset of validateId rules plus git pathspec metacharacters,
 * since dirName is used directly in git pathspecs by app-git-service.
 */
export function validateDirName(dirName: string): void {
  if (
    !dirName ||
    dirName.includes("/") ||
    dirName.includes("\\") ||
    dirName.includes("..") ||
    dirName !== dirName.trim()
  ) {
    throw new Error(`Invalid dirName: ${dirName}`);
  }
  // Reject git pathspec metacharacters
  if (/[*?[\]:()]/.test(dirName)) {
    throw new Error(
      `Invalid dirName: contains git pathspec characters: ${dirName}`,
    );
  }
}

/**
 * Validate a page filename to prevent path traversal and ensure it is a safe
 * relative filename (e.g. "settings.html").
 */
function validatePageFilename(filename: string): void {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    filename !== filename.trim() ||
    filename === "index.html" ||
    filename === "manifest.json" ||
    filename === "signature.json"
  ) {
    throw new Error(`Invalid page filename: ${filename}`);
  }
}

export function getAppsDir(): string {
  const dir = join(getDataDir(), "apps");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/**
 * Convert a name to a filesystem-safe slug.
 * - Lowercase
 * - Replace non-alphanumeric (except hyphens) with hyphens
 * - Collapse consecutive hyphens, trim leading/trailing
 * - Truncate to 60 chars (re-trim trailing hyphen)
 * - Fall back to "app-<random>" if result is empty (e.g. emoji-only names)
 */
export function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > 60) {
    slug = slug.slice(0, 60).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `app-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

/**
 * Generate a unique directory name from an app name.
 * Appends -2, -3, etc. if the base slug collides with existing names.
 */
export function generateAppDirName(
  name: string,
  existingNames: Set<string>,
): string {
  const base = slugify(name);
  if (!existingNames.has(base)) return base;
  let counter = 2;
  while (existingNames.has(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

// ---------------------------------------------------------------------------
// App directory resolution (id -> dirName)
// ---------------------------------------------------------------------------

/** Cache of id -> dirName mappings to avoid repeated filesystem scans. */
const idToDirNameCache = new Map<string, string>();
/** Reverse cache: dirName -> id. */
const dirNameToIdCache = new Map<string, string>();

/**
 * Resolve an app's directory name and path from its ID.
 * Scans JSON files if not cached. Falls back to `id` for pre-migration apps.
 */
export function resolveAppDir(id: string): {
  dirName: string;
  appDir: string;
} {
  validateId(id);

  // Check cache first
  const cached = idToDirNameCache.get(id);
  if (cached) {
    return { dirName: cached, appDir: join(getAppsDir(), cached) };
  }

  const dir = getAppsDir();
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { id?: string; dirName?: string };
      if (parsed.id === id) {
        const dirName = parsed.dirName || id;
        if (parsed.dirName) {
          validateDirName(dirName);
        }
        idToDirNameCache.set(id, dirName);
        return { dirName, appDir: join(dir, dirName) };
      }
    } catch {
      // skip malformed files
    }
  }

  // If no JSON file found, fall back to id (backward compat)
  idToDirNameCache.set(id, id);
  return { dirName: id, appDir: join(dir, id) };
}

/** Convenience wrapper: returns the app directory path for the given app ID. */
export function getAppDirPath(appId: string): string {
  return resolveAppDir(appId).appDir;
}

/**
 * Resolve an app ID from its directory name (slug).
 * Checks caches first, then reads the JSON definition file directly.
 */
export function resolveAppIdByDirName(dirName: string): string | null {
  const cached = dirNameToIdCache.get(dirName);
  if (cached) return cached;

  // Check forward cache (reverse iteration)
  for (const [id, dn] of idToDirNameCache) {
    if (dn === dirName) {
      dirNameToIdCache.set(dirName, id);
      return id;
    }
  }

  // Read the JSON definition file directly
  const dir = getAppsDir();
  const jsonPath = join(dir, `${dirName}.json`);
  if (existsSync(jsonPath)) {
    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { id?: string; dirName?: string };
      if (parsed.id) {
        dirNameToIdCache.set(dirName, parsed.id);
        idToDirNameCache.set(parsed.id, dirName);
        return parsed.id;
      }
    } catch {
      // skip malformed files
    }
  }

  return null;
}

/**
 * Extract app ID from an absolute file path if it falls within the apps
 * directory and targets a source file (not records/ or dist/).
 */
export function resolveAppIdFromPath(filePath: string): string | null {
  let appsDir: string;
  try {
    appsDir = getAppsDir();
  } catch {
    return null;
  }
  if (!filePath.startsWith(appsDir + "/")) return null;

  const relPath = filePath.slice(appsDir.length + 1);
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) return null; // file directly in apps/ (e.g. the .json definition)

  const dirName = relPath.slice(0, slashIdx);
  const innerPath = relPath.slice(slashIdx + 1);

  // Skip non-source directories
  if (innerPath.startsWith("records/") || innerPath.startsWith("dist/")) {
    return null;
  }

  return resolveAppIdByDirName(dirName);
}

/** Invalidate the id->dirName cache for a specific app or all apps. */
function invalidateDirNameCache(appId?: string): void {
  if (appId) {
    const dirName = idToDirNameCache.get(appId);
    idToDirNameCache.delete(appId);
    if (dirName) dirNameToIdCache.delete(dirName);
  } else {
    idToDirNameCache.clear();
    dirNameToIdCache.clear();
  }
}

// ---------------------------------------------------------------------------
// File path validation
// ---------------------------------------------------------------------------

/**
 * Validate a relative file path within an app directory.
 * Prevents path traversal and access to protected directories.
 * Returns the resolved absolute path.
 */
function validateFilePath(appId: string, path: string): string {
  if (!path || path.trim() === "") {
    throw new Error(`Invalid file path: path is empty`);
  }
  if (isAbsolute(path)) {
    throw new Error(`Invalid file path: absolute paths are not allowed`);
  }
  if (path.includes("..")) {
    throw new Error(`Invalid file path: '..' is not allowed`);
  }
  // Reject paths targeting records/ directory
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "records" || normalized.startsWith("records/")) {
    throw new Error(`Invalid file path: 'records/' directory is protected`);
  }
  const appDir = getAppDirPath(appId);
  const resolved = resolve(appDir, path);
  // Ensure the resolved path is still within the app directory
  if (!resolved.startsWith(appDir + "/") && resolved !== appDir) {
    throw new Error(`Invalid file path: resolves outside app directory`);
  }
  // Follow symlinks to the real path so a symlink inside the app directory
  // cannot escape the boundary. For non-existent paths, walk up to the
  // nearest existing ancestor and resolve it, then re-append trailing
  // components -- catches symlinked parent directories on new file writes.
  let realResolved: string;
  if (existsSync(resolved)) {
    realResolved = realpathSync(resolved);
  } else {
    let current = resolved;
    const trailing: string[] = [];
    realResolved = resolved;
    while (current !== dirname(current)) {
      try {
        const real = realpathSync(current);
        realResolved = trailing.length > 0 ? join(real, ...trailing) : real;
        break;
      } catch {
        trailing.unshift(basename(current));
        current = dirname(current);
      }
    }
  }
  const realAppDir = existsSync(appDir) ? realpathSync(appDir) : appDir;
  if (
    !realResolved.startsWith(realAppDir + "/") &&
    realResolved !== realAppDir
  ) {
    throw new Error(
      `Invalid file path: symlink resolves outside app directory`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Pages helpers
// ---------------------------------------------------------------------------

/** Persist pages as individual files under the app's pages/ subdirectory. */
function savePages(appDirPath: string, pages: Record<string, string>): void {
  const pagesDir = join(appDirPath, "pages");
  mkdirSync(pagesDir, { recursive: true });
  for (const [filename, content] of Object.entries(pages)) {
    validatePageFilename(filename);
    if (typeof content !== "string") {
      throw new Error(
        `Page content for "${filename}" must be a string, got ${typeof content}`,
      );
    }
    writeFileSync(join(pagesDir, filename), content, "utf-8");
  }
}

/** Load pages from disk. Returns undefined if no pages directory exists. */
function loadPages(appDirPath: string): Record<string, string> | undefined {
  const pagesDir = join(appDirPath, "pages");
  if (!existsSync(pagesDir)) return undefined;
  const entries = readdirSync(pagesDir);
  if (entries.length === 0) return undefined;
  const pages: Record<string, string> = {};
  for (const entry of entries) {
    pages[entry] = readFileSync(join(pagesDir, entry), "utf-8");
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Existing dirName collector (for dedup)
// ---------------------------------------------------------------------------

/** Scan all JSON files and build a set of existing dirName values. */
function collectExistingDirNames(): Set<string> {
  const dir = getAppsDir();
  const entries = readdirSync(dir);
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, entry), "utf-8");
      const parsed = JSON.parse(raw) as { id?: string; dirName?: string };
      // Use dirName if present, otherwise fall back to id (pre-migration)
      names.add(parsed.dirName ?? parsed.id ?? entry.replace(/\.json$/, ""));
    } catch {
      // skip malformed
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function createApp(params: {
  name: string;
  description?: string;
  icon?: string;
  preview?: string;
  schemaJson: string;
  htmlDefinition: string;
  version?: string;
  pages?: Record<string, string>;
  formatVersion?: number;
}): AppDefinition {
  const dir = getAppsDir();
  const now = Date.now();

  // Generate a unique dirName from the app name
  const existingNames = collectExistingDirNames();
  const dirName = generateAppDirName(params.name, existingNames);

  const app: AppDefinition = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    icon: params.icon,
    preview: params.preview,
    schemaJson: params.schemaJson,
    htmlDefinition: params.htmlDefinition,
    version: params.version,
    createdAt: now,
    updatedAt: now,
    formatVersion: params.formatVersion,
    dirName,
  };

  // Write htmlDefinition to {dirName}/index.html on disk
  const appDir = join(dir, dirName);
  mkdirSync(appDir, { recursive: true });
  if (typeof params.htmlDefinition !== "string") {
    throw new Error(
      `htmlDefinition must be a string, got ${typeof params.htmlDefinition}`,
    );
  }
  writeFileSync(join(appDir, "index.html"), params.htmlDefinition, "utf-8");

  // Write preview to companion file to keep the JSON small
  if (params.preview) {
    writeFileSync(join(dir, `${dirName}.preview`), params.preview, "utf-8");
  }

  // Strip htmlDefinition, pages, and preview from the JSON file -- only store metadata
  const {
    htmlDefinition: _html,
    pages: _pages,
    preview: _preview,
    ...jsonDef
  } = app;
  writeFileSync(join(dir, `${dirName}.json`), JSON.stringify(jsonDef, null, 2));

  // Update cache
  idToDirNameCache.set(app.id, dirName);

  // Persist additional pages as separate files
  if (params.pages && Object.keys(params.pages).length > 0) {
    savePages(appDir, params.pages);
    app.pages = params.pages;
  }

  return app;
}

export function getApp(id: string): AppDefinition | null {
  validateId(id);
  const { dirName, appDir } = resolveAppDir(id);
  const dir = getAppsDir();
  const filePath = join(dir, `${dirName}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const app = JSON.parse(raw) as AppDefinition;

  // Read htmlDefinition from {dirName}/index.html on disk
  const indexPath = join(appDir, "index.html");
  app.htmlDefinition = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8")
    : (app.htmlDefinition ?? "");

  // Load preview from companion file
  const previewPath = join(dir, `${dirName}.preview`);
  if (existsSync(previewPath)) {
    app.preview = readFileSync(previewPath, "utf-8");
  }

  // Load pages from disk
  const pages = loadPages(appDir);
  if (pages) {
    app.pages = pages;
  }

  return app;
}

/**
 * Load just the preview data for an app without reading the full definition.
 * Returns the base64 preview string or null if not available.
 */
export function getAppPreview(id: string): string | null {
  validateId(id);
  const { dirName } = resolveAppDir(id);
  const dir = getAppsDir();
  const previewPath = join(dir, `${dirName}.preview`);
  if (existsSync(previewPath)) {
    return readFileSync(previewPath, "utf-8");
  }
  return null;
}

export function listApps(): AppDefinition[] {
  const dir = getAppsDir();
  const entries = readdirSync(dir);
  const apps: AppDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const app = JSON.parse(raw) as AppDefinition;

      apps.push(app);
    } catch {
      // skip malformed files
    }
  }
  apps.sort((a, b) => b.updatedAt - a.updatedAt);
  return apps;
}

export function updateApp(
  id: string,
  updates: Partial<
    Pick<
      AppDefinition,
      | "name"
      | "description"
      | "icon"
      | "preview"
      | "schemaJson"
      | "htmlDefinition"
      | "version"
      | "pages"
    >
  >,
): AppDefinition {
  validateId(id);
  const existing = getApp(id);
  if (!existing) throw new Error(`App not found: ${id}`);

  const { dirName, appDir } = resolveAppDir(id);

  // Extract pages, htmlDefinition, and preview before spreading into the JSON-persisted definition
  const {
    pages,
    htmlDefinition: htmlUpdate,
    preview: previewUpdate,
    ...jsonUpdates
  } = updates;

  const updated: AppDefinition = {
    ...existing,
    ...jsonUpdates,
    updatedAt: Date.now(),
  };

  // Write htmlDefinition to {dirName}/index.html if provided in updates
  const dir = getAppsDir();
  if (htmlUpdate !== undefined) {
    updated.htmlDefinition = htmlUpdate;
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "index.html"), htmlUpdate, "utf-8");
  }

  // Write preview to companion file
  if (previewUpdate !== undefined) {
    updated.preview = previewUpdate;
    writeFileSync(join(dir, `${dirName}.preview`), previewUpdate, "utf-8");
  }

  // Don't persist htmlDefinition, pages, or preview in the JSON file -- they live as separate files
  const {
    pages: _existingPages,
    htmlDefinition: _html,
    preview: _preview,
    ...jsonDef
  } = updated;
  writeFileSync(join(dir, `${dirName}.json`), JSON.stringify(jsonDef, null, 2));

  // Clear existing pages directory before writing new pages to prevent stale files
  if (pages && Object.keys(pages).length > 0) {
    const pagesDir = join(appDir, "pages");
    if (existsSync(pagesDir)) {
      rmSync(pagesDir, { recursive: true, force: true });
    }
    savePages(appDir, pages);
  }

  // Re-attach pages to the returned object
  const loadedPages = loadPages(appDir);
  if (loadedPages) {
    updated.pages = loadedPages;
  }

  return updated;
}

export function deleteApp(id: string): void {
  validateId(id);
  const { dirName, appDir } = resolveAppDir(id);
  const dir = getAppsDir();
  const filePath = join(dir, `${dirName}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  const previewPath = join(dir, `${dirName}.preview`);
  if (existsSync(previewPath)) {
    unlinkSync(previewPath);
  }
  rmSync(appDir, { recursive: true, force: true });
  invalidateDirNameCache(id);
}

export function createAppRecord(
  appId: string,
  data: Record<string, unknown>,
): AppRecord {
  validateId(appId);
  const app = getApp(appId);
  if (!app) throw new Error(`App not found: ${appId}`);
  const recordsDir = join(getAppDirPath(appId), "records");
  mkdirSync(recordsDir, { recursive: true });
  const now = Date.now();
  const record: AppRecord = {
    id: randomUUID(),
    appId,
    data,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(
    join(recordsDir, `${record.id}.json`),
    JSON.stringify(record, null, 2),
  );
  return record;
}

export function getAppRecord(
  appId: string,
  recordId: string,
): AppRecord | null {
  validateId(appId);
  validateId(recordId);
  const filePath = join(getAppDirPath(appId), "records", `${recordId}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as AppRecord;
}

export function queryAppRecords(appId: string): AppRecord[] {
  validateId(appId);
  const recordsDir = join(getAppDirPath(appId), "records");
  if (!existsSync(recordsDir)) return [];
  const entries = readdirSync(recordsDir);
  const records: AppRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(recordsDir, entry), "utf-8");
      records.push(JSON.parse(raw) as AppRecord);
    } catch {
      // skip malformed files
    }
  }
  return records;
}

export function updateAppRecord(
  appId: string,
  recordId: string,
  data: Record<string, unknown>,
): AppRecord {
  validateId(appId);
  validateId(recordId);
  const existing = getAppRecord(appId, recordId);
  if (!existing) throw new Error(`AppRecord not found: ${appId}/${recordId}`);
  const updated: AppRecord = {
    ...existing,
    data,
    updatedAt: Date.now(),
  };
  writeFileSync(
    join(getAppDirPath(appId), "records", `${recordId}.json`),
    JSON.stringify(updated, null, 2),
  );
  return updated;
}

export function deleteAppRecord(appId: string, recordId: string): void {
  validateId(appId);
  validateId(recordId);
  const filePath = join(getAppDirPath(appId), "records", `${recordId}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// File-based app storage
// ---------------------------------------------------------------------------

/**
 * Recursively list all files under the app's directory, excluding `records/`
 * subdirectory and `app.json`. Returns relative paths like `index.html`,
 * `styles.css`, `js/app.js`.
 */
export function listAppFiles(appId: string): string[] {
  validateId(appId);
  const appDir = getAppDirPath(appId);
  if (!existsSync(appDir)) return [];

  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(appDir, fullPath);
      // Skip records/ directory
      const normalized = relPath.replace(/\\/g, "/");
      if (normalized === "records" || normalized.startsWith("records/"))
        continue;
      // Skip app.json
      if (normalized === "app.json") continue;

      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(normalized);
      }
    }
  }

  walk(appDir);
  return results.sort();
}

/**
 * Read a file from the app directory.
 * Path is validated to prevent traversal.
 */
export function readAppFile(appId: string, path: string): string {
  validateId(appId);
  const resolved = validateFilePath(appId, path);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${path}`);
  }
  return readFileSync(resolved, "utf-8");
}

/**
 * Write a file to the app directory.
 * Auto-creates intermediate directories. Path is validated to prevent traversal.
 */
export function writeAppFile(
  appId: string,
  path: string,
  content: string,
): void {
  validateId(appId);
  const resolved = validateFilePath(appId, path);
  const dir = join(resolved, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolved, content, "utf-8");
}

/**
 * Edit a file in the app directory using the edit engine (match/replace).
 * Returns the EditEngineResult from applyEdit.
 */
export function editAppFile(
  appId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): EditEngineResult {
  validateId(appId);
  const resolved = validateFilePath(appId, path);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${path}`);
  }
  const content = readFileSync(resolved, "utf-8");
  const result = applyEdit(content, oldString, newString, replaceAll ?? false);
  if (result.ok) {
    writeFileSync(resolved, result.updatedContent, "utf-8");
  }
  return result;
}

export type { EditEngineResult };
