/**
 * Local draft storage for messaging.
 *
 * Stores drafts at ~/.vellum/workspace/data/drafts/<platform>/<id>.json
 * Works across all platforms — Slack, Gmail, Discord, etc.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, pathExists } from "../util/fs.js";
import { getWorkspaceDir } from "../util/platform.js";

export interface Draft {
  id: string;
  platform: string;
  conversationId: string;
  text: string;
  threadId?: string;
  subject?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

function getDraftsDir(platform: string): string {
  const dir = join(getWorkspaceDir(), "data", "drafts", platform);
  ensureDir(dir);
  return dir;
}

function getDraftPath(platform: string, id: string): string {
  return join(getDraftsDir(platform), `${id}.json`);
}

export function createDraft(opts: {
  platform: string;
  conversationId: string;
  text: string;
  threadId?: string;
  subject?: string;
  metadata?: Record<string, unknown>;
}): Draft {
  const now = Date.now();
  const draft: Draft = {
    id: randomUUID(),
    platform: opts.platform,
    conversationId: opts.conversationId,
    text: opts.text,
    threadId: opts.threadId,
    subject: opts.subject,
    createdAt: now,
    updatedAt: now,
    metadata: opts.metadata,
  };

  writeFileSync(
    getDraftPath(draft.platform, draft.id),
    JSON.stringify(draft, null, 2),
  );
  return draft;
}

export function getDraft(platform: string, id: string): Draft | null {
  const path = getDraftPath(platform, id);
  if (!pathExists(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Draft;
}

export function listDrafts(platform: string): Draft[] {
  const dir = getDraftsDir(platform);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const drafts: Draft[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      drafts.push(JSON.parse(content) as Draft);
    } catch {
      // Skip malformed files
    }
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteDraft(platform: string, id: string): boolean {
  const path = getDraftPath(platform, id);
  if (!pathExists(path)) return false;
  unlinkSync(path);
  return true;
}
