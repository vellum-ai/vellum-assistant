/**
 * File-based persistence for user-defined apps and their records.
 *
 * Directory layout:
 *   ~/.vellum/apps/
 *     <app-id>.json            # app definition
 *     <app-id>/
 *       records/
 *         <record-id>.json     # individual record
 */

import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { applyEdit } from '../tools/shared/filesystem/edit-engine.js';
import type { EditEngineResult } from '../tools/shared/filesystem/edit-engine.js';
import {
  isPrebuiltHomeBaseApp,
  validatePrebuiltHomeBaseHtml,
} from '../home-base/prebuilt-home-base-updater.js';

export interface AppDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  preview?: string;
  schemaJson: string;
  htmlDefinition: string;
  version?: string;
  appType?: 'app' | 'site';
  /** Additional pages keyed by filename (e.g. "settings.html" → HTML content). */
  pages?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface AppRecord {
  id: string;
  appId: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function validateId(id: string): void {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id !== id.trim()) {
    throw new Error(`Invalid ID: ${id}`);
  }
}

/**
 * Validate a page filename to prevent path traversal and ensure it is a safe
 * relative filename (e.g. "settings.html").
 */
function validatePageFilename(filename: string): void {
  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename !== filename.trim() ||
    filename === 'index.html' ||
    filename === 'manifest.json' ||
    filename === 'signature.json'
  ) {
    throw new Error(`Invalid page filename: ${filename}`);
  }
}

export function getAppsDir(): string {
  const dir = join(getDataDir(), 'apps');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Validate a relative file path within an app directory.
 * Prevents path traversal and access to protected directories.
 * Returns the resolved absolute path.
 */
function validateFilePath(appId: string, path: string): string {
  if (!path || path.trim() === '') {
    throw new Error(`Invalid file path: path is empty`);
  }
  if (isAbsolute(path)) {
    throw new Error(`Invalid file path: absolute paths are not allowed`);
  }
  if (path.includes('..')) {
    throw new Error(`Invalid file path: '..' is not allowed`);
  }
  // Reject paths targeting records/ directory
  const normalized = path.replace(/\\/g, '/');
  if (normalized === 'records' || normalized.startsWith('records/')) {
    throw new Error(`Invalid file path: 'records/' directory is protected`);
  }
  const appDir = join(getAppsDir(), appId);
  const resolved = resolve(appDir, path);
  // Ensure the resolved path is still within the app directory
  if (!resolved.startsWith(appDir + '/') && resolved !== appDir) {
    throw new Error(`Invalid file path: resolves outside app directory`);
  }
  // Follow symlinks to the real path so a symlink inside the app directory
  // cannot escape the boundary. Only check when the target already exists;
  // writes to new (non-existent) paths are fine — resolve() already handled them.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realAppDir = realpathSync(appDir);
    if (!real.startsWith(realAppDir + '/') && real !== realAppDir) {
      throw new Error(`Invalid file path: symlink resolves outside app directory`);
    }
  }
  return resolved;
}

/** Persist pages as individual files under ~/.vellum/apps/{appId}/pages/. */
function savePages(appId: string, pages: Record<string, string>): void {
  const pagesDir = join(getAppsDir(), appId, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  for (const [filename, content] of Object.entries(pages)) {
    validatePageFilename(filename);
    writeFileSync(join(pagesDir, filename), content, 'utf-8');
  }
}

/** Load pages from disk. Returns undefined if no pages directory exists. */
function loadPages(appId: string): Record<string, string> | undefined {
  const pagesDir = join(getAppsDir(), appId, 'pages');
  if (!existsSync(pagesDir)) return undefined;
  const entries = readdirSync(pagesDir);
  if (entries.length === 0) return undefined;
  const pages: Record<string, string> = {};
  for (const entry of entries) {
    pages[entry] = readFileSync(join(pagesDir, entry), 'utf-8');
  }
  return pages;
}

export function createApp(params: {
  name: string;
  description?: string;
  icon?: string;
  preview?: string;
  schemaJson: string;
  htmlDefinition: string;
  version?: string;
  appType?: 'app' | 'site';
  pages?: Record<string, string>;
}): AppDefinition {
  const dir = getAppsDir();
  const now = Date.now();
  const app: AppDefinition = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    icon: params.icon,
    preview: params.preview,
    schemaJson: params.schemaJson,
    htmlDefinition: params.htmlDefinition,
    version: params.version,
    appType: params.appType,
    createdAt: now,
    updatedAt: now,
  };

  // Write htmlDefinition to {appId}/index.html on disk
  const appDir = join(dir, app.id);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'index.html'), params.htmlDefinition, 'utf-8');

  // Strip htmlDefinition and pages from the JSON file — only store metadata
  const { htmlDefinition: _html, pages: _pages, ...jsonDef } = app;
  writeFileSync(join(dir, `${app.id}.json`), JSON.stringify(jsonDef, null, 2));

  // Persist additional pages as separate files
  if (params.pages && Object.keys(params.pages).length > 0) {
    savePages(app.id, params.pages);
    app.pages = params.pages;
  }

  return app;
}

export function getApp(id: string): AppDefinition | null {
  validateId(id);
  const filePath = join(getAppsDir(), `${id}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const app = JSON.parse(raw) as AppDefinition;

  // Read htmlDefinition from {appId}/index.html on disk
  const indexPath = join(getAppsDir(), id, 'index.html');
  app.htmlDefinition = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf-8')
    : (app.htmlDefinition ?? '');

  // Load pages from disk
  const pages = loadPages(id);
  if (pages) {
    app.pages = pages;
  }

  return app;
}

export function listApps(): AppDefinition[] {
  const dir = getAppsDir();
  const entries = readdirSync(dir);
  const apps: AppDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      apps.push(JSON.parse(raw) as AppDefinition);
    } catch {
      // skip malformed files
    }
  }
  apps.sort((a, b) => b.updatedAt - a.updatedAt);
  return apps;
}

export function updateApp(
  id: string,
  updates: Partial<Pick<AppDefinition, 'name' | 'description' | 'icon' | 'preview' | 'schemaJson' | 'htmlDefinition' | 'version' | 'appType' | 'pages'>>,
): AppDefinition {
  validateId(id);
  const existing = getApp(id);
  if (!existing) throw new Error(`App not found: ${id}`);

  if (typeof updates.htmlDefinition === 'string' && isPrebuiltHomeBaseApp(existing)) {
    const validation = validatePrebuiltHomeBaseHtml(updates.htmlDefinition);
    if (!validation.valid) {
      throw new Error(`Home Base update missing required anchors: ${validation.missingAnchors.join(', ')}`);
    }
  }

  // Extract pages and htmlDefinition before spreading into the JSON-persisted definition
  const { pages, htmlDefinition: htmlUpdate, ...jsonUpdates } = updates;

  const updated: AppDefinition = {
    ...existing,
    ...jsonUpdates,
    updatedAt: Date.now(),
  };

  // Write htmlDefinition to {appId}/index.html if provided in updates
  const appDir = join(getAppsDir(), id);
  if (htmlUpdate !== undefined) {
    updated.htmlDefinition = htmlUpdate;
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.html'), htmlUpdate, 'utf-8');
  } else if (!existsSync(join(appDir, 'index.html')) && updated.htmlDefinition) {
    // Backfill: migrate existing htmlDefinition to index.html before stripping from JSON
    // to prevent data loss on metadata-only updates of pre-migration apps.
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.html'), updated.htmlDefinition, 'utf-8');
  }

  // Don't persist htmlDefinition or pages in the JSON file — they live as separate files
  const { pages: _existingPages, htmlDefinition: _html, ...jsonDef } = updated;
  writeFileSync(join(getAppsDir(), `${id}.json`), JSON.stringify(jsonDef, null, 2));

  // Clear existing pages directory before writing new pages to prevent stale files
  if (pages && Object.keys(pages).length > 0) {
    const pagesDir = join(getAppsDir(), id, 'pages');
    if (existsSync(pagesDir)) {
      rmSync(pagesDir, { recursive: true, force: true });
    }
    savePages(id, pages);
  }

  // Re-attach pages to the returned object
  const loadedPages = loadPages(id);
  if (loadedPages) {
    updated.pages = loadedPages;
  }

  return updated;
}

export function deleteApp(id: string): void {
  validateId(id);
  const dir = getAppsDir();
  const filePath = join(dir, `${id}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  const appDir = join(dir, id);
  rmSync(appDir, { recursive: true, force: true });
}

export function createAppRecord(appId: string, data: Record<string, unknown>): AppRecord {
  validateId(appId);
  const app = getApp(appId);
  if (!app) throw new Error(`App not found: ${appId}`);
  const recordsDir = join(getAppsDir(), appId, 'records');
  mkdirSync(recordsDir, { recursive: true });
  const now = Date.now();
  const record: AppRecord = {
    id: randomUUID(),
    appId,
    data,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(join(recordsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function getAppRecord(appId: string, recordId: string): AppRecord | null {
  validateId(appId);
  validateId(recordId);
  const filePath = join(getAppsDir(), appId, 'records', `${recordId}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as AppRecord;
}

export function queryAppRecords(appId: string): AppRecord[] {
  validateId(appId);
  const recordsDir = join(getAppsDir(), appId, 'records');
  if (!existsSync(recordsDir)) return [];
  const entries = readdirSync(recordsDir);
  const records: AppRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(recordsDir, entry), 'utf-8');
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
    join(getAppsDir(), appId, 'records', `${recordId}.json`),
    JSON.stringify(updated, null, 2),
  );
  return updated;
}

export function deleteAppRecord(appId: string, recordId: string): void {
  validateId(appId);
  validateId(recordId);
  const filePath = join(getAppsDir(), appId, 'records', `${recordId}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// File-based app storage
// ---------------------------------------------------------------------------

/**
 * Recursively list all files under `{appId}/`, excluding `records/` subdirectory
 * and `app.json`. Returns relative paths like `index.html`, `styles.css`, `js/app.js`.
 */
export function listAppFiles(appId: string): string[] {
  validateId(appId);
  const appDir = join(getAppsDir(), appId);
  if (!existsSync(appDir)) return [];

  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(appDir, fullPath);
      // Skip records/ directory
      const normalized = relPath.replace(/\\/g, '/');
      if (normalized === 'records' || normalized.startsWith('records/')) continue;
      // Skip app.json
      if (normalized === 'app.json') continue;

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
  return readFileSync(resolved, 'utf-8');
}

/**
 * Write a file to the app directory.
 * Auto-creates intermediate directories. Path is validated to prevent traversal.
 */
export function writeAppFile(appId: string, path: string, content: string): void {
  validateId(appId);
  const resolved = validateFilePath(appId, path);
  const dir = join(resolved, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolved, content, 'utf-8');
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
  const content = readFileSync(resolved, 'utf-8');
  const result = applyEdit(content, oldString, newString, replaceAll ?? false);
  if (result.ok) {
    writeFileSync(resolved, result.updatedContent, 'utf-8');
  }
  return result;
}

export type { EditEngineResult };
