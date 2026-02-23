/**
 * Media asset storage and processing stage tracking.
 *
 * Provides CRUD operations for the media_assets and processing_stages tables.
 * Uses content-hash deduplication (same pattern as attachments-store.ts).
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { mediaAssets, processingStages } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaAssetStatus = 'registered' | 'processing' | 'indexed' | 'failed';
export type MediaType = 'video' | 'audio' | 'image';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface MediaAsset {
  id: string;
  title: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number | null;
  fileHash: string;
  status: MediaAssetStatus;
  mediaType: MediaType;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProcessingStage {
  id: string;
  assetId: string;
  stage: string;
  status: StageStatus;
  progress: number;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute a content hash for deduplication. Uses Bun.hash (wyhash) for speed,
 * encoded as base-36 for compact storage.
 */
export function computeFileHash(data: Buffer | Uint8Array): string {
  return Bun.hash(data).toString(36);
}

// ---------------------------------------------------------------------------
// Media asset CRUD
// ---------------------------------------------------------------------------

export function registerMediaAsset(params: {
  title: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number | null;
  fileHash: string;
  mediaType: MediaType;
  metadata?: Record<string, unknown>;
}): MediaAsset {
  const db = getDb();

  // Dedup: if an asset with the same content hash already exists, return it
  const existing = db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.fileHash, params.fileHash))
    .get();

  if (existing) {
    return parseAssetRow(existing);
  }

  const now = Date.now();
  const record = {
    id: uuid(),
    title: params.title,
    filePath: params.filePath,
    mimeType: params.mimeType,
    durationSeconds: params.durationSeconds,
    fileHash: params.fileHash,
    status: 'registered' as const,
    mediaType: params.mediaType,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(mediaAssets).values(record).run();

  return {
    ...record,
    metadata: params.metadata ?? null,
  };
}

export function getMediaAssetById(id: string): MediaAsset | null {
  const db = getDb();
  const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
  return row ? parseAssetRow(row) : null;
}

export function getMediaAssetByFilePath(filePath: string): MediaAsset | null {
  const db = getDb();
  const row = db.select().from(mediaAssets).where(eq(mediaAssets.filePath, filePath)).get();
  return row ? parseAssetRow(row) : null;
}

export function getMediaAssetByHash(fileHash: string): MediaAsset | null {
  const db = getDb();
  const row = db.select().from(mediaAssets).where(eq(mediaAssets.fileHash, fileHash)).get();
  return row ? parseAssetRow(row) : null;
}

export function getMediaAssetsByStatus(status: MediaAssetStatus): MediaAsset[] {
  const db = getDb();
  const rows = db.select().from(mediaAssets).where(eq(mediaAssets.status, status)).all();
  return rows.map(parseAssetRow);
}

export function updateMediaAssetStatus(id: string, status: MediaAssetStatus): void {
  const db = getDb();
  db.update(mediaAssets)
    .set({ status, updatedAt: Date.now() })
    .where(eq(mediaAssets.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Processing stage CRUD
// ---------------------------------------------------------------------------

export function createProcessingStage(params: {
  assetId: string;
  stage: string;
}): ProcessingStage {
  const db = getDb();
  const record = {
    id: uuid(),
    assetId: params.assetId,
    stage: params.stage,
    status: 'pending' as const,
    progress: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
  };

  db.insert(processingStages).values(record).run();
  return record;
}

export function getProcessingStagesForAsset(assetId: string): ProcessingStage[] {
  const db = getDb();
  const rows = db
    .select()
    .from(processingStages)
    .where(eq(processingStages.assetId, assetId))
    .all();
  return rows.map(parseStageRow);
}

export function updateProcessingStage(
  id: string,
  updates: Partial<Pick<ProcessingStage, 'status' | 'progress' | 'lastError' | 'startedAt' | 'completedAt'>>,
): void {
  const db = getDb();
  db.update(processingStages)
    .set(updates)
    .where(eq(processingStages.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function parseAssetRow(row: typeof mediaAssets.$inferSelect): MediaAsset {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    filePath: row.filePath,
    mimeType: row.mimeType,
    durationSeconds: row.durationSeconds,
    fileHash: row.fileHash,
    status: row.status as MediaAssetStatus,
    mediaType: row.mediaType as MediaType,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStageRow(row: typeof processingStages.$inferSelect): ProcessingStage {
  return {
    id: row.id,
    assetId: row.assetId,
    stage: row.stage,
    status: row.status as StageStatus,
    progress: row.progress,
    lastError: row.lastError,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
