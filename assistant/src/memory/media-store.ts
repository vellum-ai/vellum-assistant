/**
 * Media asset storage and processing stage tracking.
 *
 * Provides CRUD operations for the media_assets and processing_stages tables.
 * Uses content-hash deduplication (same pattern as attachments-store.ts).
 */

import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db.js";
import {
  mediaAssets,
  mediaEvents,
  mediaKeyframes,
  mediaVisionOutputs,
  processingStages,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaAssetStatus =
  | "registered"
  | "processing"
  | "indexed"
  | "failed"
  | "cancelled";
export type MediaType = "video" | "audio" | "image";
export type StageStatus = "pending" | "running" | "completed" | "failed";

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
 * Streaming content hashing that avoids loading the entire file into memory.
 * Uses SHA-256 via Bun.CryptoHasher so multi-GB files won't OOM.
 */
export async function computeFileHashStreaming(
  filePath: string,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(filePath).stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
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
    status: "registered" as const,
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
  const row = db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.filePath, filePath))
    .get();
  return row ? parseAssetRow(row) : null;
}

export function getMediaAssetByHash(fileHash: string): MediaAsset | null {
  const db = getDb();
  const row = db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.fileHash, fileHash))
    .get();
  return row ? parseAssetRow(row) : null;
}

export function getMediaAssetsByStatus(status: MediaAssetStatus): MediaAsset[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.status, status))
    .all();
  return rows.map(parseAssetRow);
}

export function updateMediaAssetStatus(
  id: string,
  status: MediaAssetStatus,
): void {
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
    status: "pending" as const,
    progress: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
  };

  db.insert(processingStages).values(record).run();
  return record;
}

export function getProcessingStagesForAsset(
  assetId: string,
): ProcessingStage[] {
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
  updates: Partial<
    Pick<
      ProcessingStage,
      "status" | "progress" | "lastError" | "startedAt" | "completedAt"
    >
  >,
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

function parseStageRow(
  row: typeof processingStages.$inferSelect,
): ProcessingStage {
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

// ---------------------------------------------------------------------------
// Keyframe types & CRUD
// ---------------------------------------------------------------------------

export interface MediaKeyframe {
  id: string;
  assetId: string;
  timestamp: number;
  filePath: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export function insertKeyframe(params: {
  assetId: string;
  timestamp: number;
  filePath: string;
  metadata?: Record<string, unknown>;
}): MediaKeyframe {
  const db = getDb();
  const now = Date.now();
  const record = {
    id: uuid(),
    assetId: params.assetId,
    timestamp: params.timestamp,
    filePath: params.filePath,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
  };
  db.insert(mediaKeyframes).values(record).run();
  return { ...record, metadata: params.metadata ?? null };
}

export function insertKeyframesBatch(
  rows: Array<{
    assetId: string;
    timestamp: number;
    filePath: string;
    metadata?: Record<string, unknown>;
  }>,
): MediaKeyframe[] {
  const db = getDb();
  const now = Date.now();
  const records = rows.map((r) => ({
    id: uuid(),
    assetId: r.assetId,
    timestamp: r.timestamp,
    filePath: r.filePath,
    metadata: r.metadata ? JSON.stringify(r.metadata) : null,
    createdAt: now,
  }));
  if (records.length > 0) {
    db.insert(mediaKeyframes).values(records).run();
  }
  return records.map((rec, i) => ({
    ...rec,
    metadata: rows[i].metadata ?? null,
  }));
}

export function getKeyframesForAsset(assetId: string): MediaKeyframe[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mediaKeyframes)
    .where(eq(mediaKeyframes.assetId, assetId))
    .all();
  return rows.map(parseKeyframeRow);
}

export function deleteKeyframesForAsset(assetId: string): void {
  const db = getDb();
  db.delete(mediaKeyframes).where(eq(mediaKeyframes.assetId, assetId)).run();
}

function parseKeyframeRow(
  row: typeof mediaKeyframes.$inferSelect,
): MediaKeyframe {
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
    assetId: row.assetId,
    timestamp: row.timestamp,
    filePath: row.filePath,
    metadata,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Vision output types & CRUD
// ---------------------------------------------------------------------------

export interface MediaVisionOutput {
  id: string;
  assetId: string;
  keyframeId: string;
  analysisType: string;
  output: Record<string, unknown>;
  confidence: number | null;
  createdAt: number;
}

export function insertVisionOutputsBatch(
  rows: Array<{
    assetId: string;
    keyframeId: string;
    analysisType: string;
    output: Record<string, unknown>;
    confidence?: number;
  }>,
): MediaVisionOutput[] {
  const db = getDb();
  const now = Date.now();
  const records = rows.map((r) => ({
    id: uuid(),
    assetId: r.assetId,
    keyframeId: r.keyframeId,
    analysisType: r.analysisType,
    output: JSON.stringify(r.output),
    confidence: r.confidence ?? null,
    createdAt: now,
  }));
  if (records.length > 0) {
    db.insert(mediaVisionOutputs).values(records).run();
  }
  return records.map((rec, i) => ({
    ...rec,
    output: rows[i].output,
  }));
}

export function getVisionOutputsForAsset(
  assetId: string,
  analysisType?: string,
): MediaVisionOutput[] {
  const db = getDb();
  const conditions = [eq(mediaVisionOutputs.assetId, assetId)];
  if (analysisType) {
    conditions.push(eq(mediaVisionOutputs.analysisType, analysisType));
  }
  const rows = db
    .select()
    .from(mediaVisionOutputs)
    .where(and(...conditions))
    .all();
  return rows.map(parseVisionOutputRow);
}

export function getVisionOutputsByKeyframeIds(
  keyframeIds: string[],
): MediaVisionOutput[] {
  if (keyframeIds.length === 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(mediaVisionOutputs)
    .where(inArray(mediaVisionOutputs.keyframeId, keyframeIds))
    .all();
  return rows.map(parseVisionOutputRow);
}

function parseVisionOutputRow(
  row: typeof mediaVisionOutputs.$inferSelect,
): MediaVisionOutput {
  let output: Record<string, unknown> = {};
  try {
    output = JSON.parse(row.output) as Record<string, unknown>;
  } catch {
    output = {};
  }
  return {
    id: row.id,
    assetId: row.assetId,
    keyframeId: row.keyframeId,
    analysisType: row.analysisType,
    output,
    confidence: row.confidence,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Media event types & CRUD
// ---------------------------------------------------------------------------

export interface MediaEvent {
  id: string;
  assetId: string;
  eventType: string;
  startTime: number;
  endTime: number;
  confidence: number;
  reasons: string[];
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export function getEventsForAsset(
  assetId: string,
  filters?: {
    eventType?: string;
    minConfidence?: number;
    limit?: number;
    sortBy?: "confidence" | "startTime";
  },
): MediaEvent[] {
  const db = getDb();
  const conditions = [eq(mediaEvents.assetId, assetId)];
  if (filters?.eventType) {
    conditions.push(eq(mediaEvents.eventType, filters.eventType));
  }
  if (filters?.minConfidence !== undefined) {
    conditions.push(gte(mediaEvents.confidence, filters.minConfidence));
  }

  let query = db
    .select()
    .from(mediaEvents)
    .where(and(...conditions))
    .$dynamic();

  if (filters?.sortBy === "confidence") {
    query = query.orderBy(desc(mediaEvents.confidence));
  } else {
    query = query.orderBy(asc(mediaEvents.startTime));
  }

  if (filters?.limit) {
    query = query.limit(filters.limit);
  }

  const rows = query.all();
  return rows.map(parseEventRow);
}

function parseEventRow(row: typeof mediaEvents.$inferSelect): MediaEvent {
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(row.reasons) as string[];
  } catch {
    reasons = [];
  }
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
    assetId: row.assetId,
    eventType: row.eventType,
    startTime: row.startTime,
    endTime: row.endTime,
    confidence: row.confidence,
    reasons,
    metadata,
    createdAt: row.createdAt,
  };
}
