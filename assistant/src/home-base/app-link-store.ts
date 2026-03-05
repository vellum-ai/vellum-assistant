import { eq } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { homeBaseAppLinks } from "../memory/schema.js";

const HOME_BASE_LINK_ID = "default";

export interface HomeBaseAppLink {
  id: string;
  appId: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

function mapRowToLink(
  row: typeof homeBaseAppLinks.$inferSelect,
): HomeBaseAppLink {
  return {
    id: row.id,
    appId: row.appId,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getHomeBaseAppLink(): HomeBaseAppLink | null {
  const db = getDb();
  const row = db
    .select()
    .from(homeBaseAppLinks)
    .where(eq(homeBaseAppLinks.id, HOME_BASE_LINK_ID))
    .get();

  return row ? mapRowToLink(row) : null;
}

export function setHomeBaseAppLink(
  appId: string,
  source: string,
): HomeBaseAppLink {
  const db = getDb();
  const now = Date.now();
  const existing = getHomeBaseAppLink();

  if (existing) {
    db.update(homeBaseAppLinks)
      .set({ appId, source, updatedAt: now })
      .where(eq(homeBaseAppLinks.id, HOME_BASE_LINK_ID))
      .run();

    return {
      ...existing,
      appId,
      source,
      updatedAt: now,
    };
  }

  db.insert(homeBaseAppLinks)
    .values({
      id: HOME_BASE_LINK_ID,
      appId,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    id: HOME_BASE_LINK_ID,
    appId,
    source,
    createdAt: now,
    updatedAt: now,
  };
}
