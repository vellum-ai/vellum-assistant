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
} from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../util/platform.js';

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
  writeFileSync(join(dir, `${app.id}.json`), JSON.stringify(app, null, 2));

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

  // Extract pages before spreading into the JSON-persisted definition
  const { pages, ...jsonUpdates } = updates;

  const updated: AppDefinition = {
    ...existing,
    ...jsonUpdates,
    updatedAt: Date.now(),
  };

  // Don't persist pages in the JSON file — they live as separate files
  const { pages: _existingPages, ...jsonDef } = updated;
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
