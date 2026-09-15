import type { Database } from "bun:sqlite";

import { getMemorySqlite } from "../db-connection.js";

/** Create the retrospective skill monitoring tables in assistant-memory.db. */
export function ensureMemoryRetrospectiveSkillMonitoringSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_retrospective_skill_searches (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_conversation_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      outcome TEXT,
      reason TEXT,
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_retro_skill_searches_conversation_created
      ON memory_retrospective_skill_searches(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_memory_retro_skill_searches_run_created
      ON memory_retrospective_skill_searches(run_conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_retrospective_skill_candidates (
      id TEXT PRIMARY KEY,
      search_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_conversation_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_description TEXT NOT NULL,
      skill_source TEXT NOT NULL,
      skill_author TEXT,
      consideration_status TEXT NOT NULL,
      system_exclusion_reason TEXT,
      rank INTEGER,
      score REAL,
      decision TEXT,
      reason TEXT,
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_retro_skill_candidates_search_skill
      ON memory_retrospective_skill_candidates(search_id, skill_id);

    CREATE INDEX IF NOT EXISTS idx_memory_retro_skill_candidates_conversation_created
      ON memory_retrospective_skill_candidates(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_retrospective_skill_changes (
      id TEXT PRIMARY KEY,
      search_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_conversation_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      delta TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_retro_skill_changes_search
      ON memory_retrospective_skill_changes(search_id);

    CREATE INDEX IF NOT EXISTS idx_memory_retro_skill_changes_conversation_created
      ON memory_retrospective_skill_changes(conversation_id, created_at);
  `);
}

export function migrateCreateMemoryRetrospectiveSkillMonitoring(): void {
  const raw = getMemorySqlite();
  if (!raw) {
    throw new Error(
      "memory database unavailable; deferring retrospective skill monitoring schema",
    );
  }
  ensureMemoryRetrospectiveSkillMonitoringSchema(raw);
}
