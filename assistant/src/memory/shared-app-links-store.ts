/**
 * Store for cloud-shared app link records.
 *
 * Each record holds a .vellumapp zip bundle keyed by a short, shareable token.
 */

import { eq } from 'drizzle-orm';
import { randomUUID, randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { sharedAppLinks } from './schema.js';
import type { AppManifest } from '../bundler/manifest.js';

export interface SharedAppLinkRecord {
  id: string;
  shareToken: string;
  bundleData: Buffer;
  bundleSizeBytes: number;
  manifestJson: string;
  downloadCount: number;
  createdAt: number;
  expiresAt: number | null;
}

function generateShareToken(): string {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

export function createSharedAppLink(
  bundleData: Buffer,
  manifest: AppManifest,
): { id: string; shareToken: string } {
  const db = getDb();
  const id = randomUUID();
  const shareToken = generateShareToken();
  const now = Date.now();

  db.insert(sharedAppLinks)
    .values({
      id,
      shareToken,
      bundleData,
      bundleSizeBytes: bundleData.length,
      manifestJson: JSON.stringify(manifest),
      downloadCount: 0,
      createdAt: now,
      expiresAt: null,
    })
    .run();

  return { id, shareToken };
}

export function getSharedAppLink(shareToken: string): SharedAppLinkRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    shareToken: row.shareToken,
    bundleData: row.bundleData as Buffer,
    bundleSizeBytes: row.bundleSizeBytes,
    manifestJson: row.manifestJson,
    downloadCount: row.downloadCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function deleteSharedAppLink(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: sharedAppLinks.id })
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.id, id))
    .get();

  if (!existing) return false;

  db.delete(sharedAppLinks)
    .where(eq(sharedAppLinks.id, id))
    .run();

  return true;
}

export function deleteSharedAppLinkByToken(shareToken: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: sharedAppLinks.id })
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken))
    .get();

  if (!existing) return false;

  db.delete(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken))
    .run();

  return true;
}

export function incrementDownloadCount(shareToken: string): void {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  raw.prepare(
    `UPDATE shared_app_links SET download_count = download_count + 1 WHERE share_token = ?`,
  ).run(shareToken);
}
