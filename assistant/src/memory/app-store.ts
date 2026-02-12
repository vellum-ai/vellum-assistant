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
  schemaJson: string;
  htmlDefinition: string;
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

export function getAppsDir(): string {
  const dir = join(getDataDir(), 'apps');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createApp(params: {
  name: string;
  description?: string;
  schemaJson: string;
  htmlDefinition: string;
}): AppDefinition {
  const dir = getAppsDir();
  const now = Date.now();
  const app: AppDefinition = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    schemaJson: params.schemaJson,
    htmlDefinition: params.htmlDefinition,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(join(dir, `${app.id}.json`), JSON.stringify(app, null, 2));
  return app;
}

export function getApp(id: string): AppDefinition | null {
  validateId(id);
  const filePath = join(getAppsDir(), `${id}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as AppDefinition;
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
  updates: Partial<Pick<AppDefinition, 'name' | 'description' | 'schemaJson' | 'htmlDefinition'>>,
): AppDefinition {
  validateId(id);
  const existing = getApp(id);
  if (!existing) throw new Error(`App not found: ${id}`);
  const updated: AppDefinition = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
  writeFileSync(join(getAppsDir(), `${id}.json`), JSON.stringify(updated, null, 2));
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
