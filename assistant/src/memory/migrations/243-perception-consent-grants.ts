import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Multimodal Perception MVP — Phase 10C.
 *
 * Adds `perception_consent_grants` to back the per-conversation consent
 * gate for sensitive perception event kinds (`screen_snapshot`,
 * `audio_excerpt`). One row per (scope_id, conversation_id, event_kind);
 * tracks when the grant was issued, when it expires, and when it was
 * revoked.
 *
 * Wired through the existing `confirmation_request` → `POST /v1/confirm`
 * flow (no new approval primitive). On `allow_conversation`, the route
 * inserts a row here; subsequent publish-route calls for the same triple
 * short-circuit. On `deny` / `always_deny`, no row is written and the
 * publish route rejects with `{ accepted: false, reason: "consent_required" }`.
 *
 * Uses IF NOT EXISTS for idempotency.
 */
export function migratePerceptionConsentGrants(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS perception_consent_grants (
      id              TEXT PRIMARY KEY,
      scope_id        TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT NOT NULL,
      event_kind      TEXT NOT NULL,
      granted_at      INTEGER NOT NULL,
      expires_at      INTEGER,
      revoked_at      INTEGER,
      created_at      INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_perception_consent_grants_triple
      ON perception_consent_grants(scope_id, conversation_id, event_kind)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_perception_consent_grants_expires
      ON perception_consent_grants(expires_at)
  `);
}
