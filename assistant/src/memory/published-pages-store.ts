/**
 * Store for published page records.
 *
 * Tracks HTML pages deployed to Vercel, keyed by deployment ID and content hash
 * for deduplication.
 */

import { eq, and } from 'drizzle-orm';
import { getDb } from './db.js';
import { publishedPages } from './schema.js';

export interface PublishedPageRecord {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle: string | null;
  htmlHash: string;
  publishedAt: number;
  status: string;
}

export function createPublishedPage(record: {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle?: string;
  htmlHash: string;
}): void {
  const db = getDb();
  db.insert(publishedPages)
    .values({
      id: record.id,
      deploymentId: record.deploymentId,
      publicUrl: record.publicUrl,
      pageTitle: record.pageTitle ?? null,
      htmlHash: record.htmlHash,
      publishedAt: Date.now(),
      status: 'active',
    })
    .run();
}

export function getPublishedPageByDeploymentId(
  deploymentId: string,
): PublishedPageRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(publishedPages)
    .where(eq(publishedPages.deploymentId, deploymentId))
    .get();

  return row ?? null;
}

export function getPublishedPageByHash(
  hash: string,
): PublishedPageRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(publishedPages)
    .where(
      and(
        eq(publishedPages.htmlHash, hash),
        eq(publishedPages.status, 'active'),
      ),
    )
    .get();

  return row ?? null;
}

export function listPublishedPages(): PublishedPageRecord[] {
  const db = getDb();
  return db
    .select()
    .from(publishedPages)
    .where(eq(publishedPages.status, 'active'))
    .all();
}

export function markDeleted(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: publishedPages.id })
    .from(publishedPages)
    .where(eq(publishedPages.id, id))
    .get();

  if (!existing) return false;

  db.update(publishedPages)
    .set({ status: 'deleted' })
    .where(eq(publishedPages.id, id))
    .run();

  return true;
}
