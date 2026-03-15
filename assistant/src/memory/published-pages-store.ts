/**
 * Store for published page records.
 *
 * Tracks HTML pages deployed to Vercel, keyed by deployment ID and content hash
 * for deduplication.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "./db.js";
import { publishedPages } from "./schema.js";

export interface PublishedPageRecord {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle: string | null;
  htmlHash: string;
  publishedAt: number;
  status: string;
  appId: string | null;
  projectSlug: string | null;
}

export function getActivePublishedPageByAppId(
  appId: string,
): PublishedPageRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(publishedPages)
    .where(
      and(eq(publishedPages.appId, appId), eq(publishedPages.status, "active")),
    )
    .get();
  return row ?? null;
}

export function updatePublishedPage(
  id: string,
  updates: {
    deploymentId?: string;
    publicUrl?: string;
    htmlHash?: string;
    publishedAt?: number;
    appId?: string;
  },
): void {
  const db = getDb();
  db.update(publishedPages).set(updates).where(eq(publishedPages.id, id)).run();
}
