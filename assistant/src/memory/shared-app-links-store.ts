/**
 * Store for cloud-shared app link records.
 *
 * Each record holds a .vellum zip bundle keyed by a short, shareable token.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import type { AppManifest } from "../bundler/manifest.js";
import { getDb, rawRun } from "./db.js";
import { sharedAppLinks } from "./schema.js";

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

const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateShareToken(): string {
  // 16 bytes = 128 bits of entropy (matches UUID standard), base64url-encoded
  // to a 22-character URL-safe string.
  return randomBytes(16).toString("base64url");
}

/** Delete all rows whose effective expiry has passed (including legacy NULL rows). */
function sweepExpiredLinks(): void {
  const db = getDb();
  const now = Date.now();
  db.delete(sharedAppLinks)
    .where(
      or(
        lte(sharedAppLinks.expiresAt, now),
        // Legacy rows created before TTL was added have expiresAt = NULL;
        // treat them as expired once createdAt + TTL has passed.
        and(
          isNull(sharedAppLinks.expiresAt),
          lte(sharedAppLinks.createdAt, now - SHARE_LINK_TTL_MS),
        ),
      ),
    )
    .run();
}

export function createSharedAppLink(
  bundleData: Buffer,
  manifest: AppManifest,
): { id: string; shareToken: string } {
  sweepExpiredLinks();

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
      expiresAt: now + SHARE_LINK_TTL_MS,
    })
    .run();

  return { id, shareToken };
}

export function getSharedAppLink(
  shareToken: string,
): SharedAppLinkRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken))
    .get();

  if (!row) return null;

  const effectiveExpiry = row.expiresAt ?? row.createdAt + SHARE_LINK_TTL_MS;
  if (effectiveExpiry < Date.now()) return null;

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
  rawRun(
    `UPDATE shared_app_links SET download_count = download_count + 1 WHERE share_token = ?`,
    shareToken,
  );
}
