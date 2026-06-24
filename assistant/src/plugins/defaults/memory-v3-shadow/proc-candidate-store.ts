/**
 * Procedural-memory candidate registry (migration 302).
 *
 * Backed by `proc_candidates`: one row per recurrence cluster of related notes
 * tracked toward a distilled procedure. `memberNoteSlugs` is a set of the note
 * slugs that have joined the cluster (persisted as a JSON array), `count` is
 * the observed recurrence tally, and `status` walks `observing → ready →
 * distilled` as a cluster accumulates evidence. `explicit` flags clusters
 * seeded by a direct user request rather than passive observation.
 */

import { getDb, getSqliteFrom } from "../../../memory/db-connection.js";

export type ProcCandidateStatus = "observing" | "ready" | "distilled";

export interface ProcCandidate {
  clusterId: string;
  goal: string;
  memberNoteSlugs: string[];
  count: number;
  status: ProcCandidateStatus;
  explicit: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ProcCandidateRow {
  clusterId: string;
  goal: string;
  memberNoteSlugs: string;
  count: number;
  status: ProcCandidateStatus;
  explicit: number;
  createdAt: number;
  updatedAt: number;
}

function rowToCandidate(row: ProcCandidateRow): ProcCandidate {
  return {
    clusterId: row.clusterId,
    goal: row.goal,
    memberNoteSlugs: JSON.parse(row.memberNoteSlugs) as string[],
    count: row.count,
    status: row.status,
    explicit: row.explicit !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertCandidateInput {
  clusterId: string;
  goal: string;
  memberNoteSlugs?: string[];
  count?: number;
  status?: ProcCandidateStatus;
  explicit?: boolean;
}

/**
 * Insert a candidate cluster, or refresh `goal` and stamp `updated_at` when one
 * already exists. The accumulated fields — `member_note_slugs`, `count`,
 * `status`, `explicit`, and `created_at` — are PRESERVED on conflict; they are
 * owned by the dedicated mutators (`incrementCandidate`, `addMemberNote`,
 * `markCandidateStatus`), so re-upserting with only the required fields never
 * clobbers accumulated evidence.
 */
export function upsertCandidate(
  input: UpsertCandidateInput,
  at: number = Date.now(),
): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      INSERT INTO proc_candidates
        (cluster_id, goal, member_note_slugs, count, status, explicit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cluster_id) DO UPDATE SET
        goal = excluded.goal,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.clusterId,
      input.goal,
      JSON.stringify(input.memberNoteSlugs ?? []),
      input.count ?? 0,
      input.status ?? "observing",
      input.explicit ? 1 : 0,
      at,
      at,
    );
}

/** Bump a cluster's recurrence tally by one and stamp `updated_at`. */
export function incrementCandidate(
  clusterId: string,
  at: number = Date.now(),
): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      UPDATE proc_candidates SET count = count + 1, updated_at = ?
      WHERE cluster_id = ?
    `,
    )
    .run(at, clusterId);
}

/**
 * OR `explicit` on for a cluster (set it to 1) and stamp `updated_at`. Never
 * clobbers an already-true value — the `WHERE explicit = 0` guard makes a
 * re-call on an already-explicit cluster a no-op, so `updated_at` only moves
 * when the flag actually flips. No-op when the cluster is not registered.
 *
 * Used when an `explicit` candidate note JOINS an existing `observing` cluster:
 * the join path must carry the note's explicit-ness onto the cluster so the
 * readiness check (`count >= minRecurrence || cluster.explicit`) can fire.
 */
export function setCandidateExplicit(
  clusterId: string,
  at: number = Date.now(),
): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      UPDATE proc_candidates SET explicit = 1, updated_at = ?
      WHERE cluster_id = ? AND explicit = 0
    `,
    )
    .run(at, clusterId);
}

/** Fetch a single cluster, or `null` when it is not registered. */
export function getCandidate(clusterId: string): ProcCandidate | null {
  const row = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT
        cluster_id AS clusterId,
        goal,
        member_note_slugs AS memberNoteSlugs,
        count,
        status,
        explicit,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM proc_candidates
      WHERE cluster_id = ?
    `,
    )
    .get(clusterId) as ProcCandidateRow | null;
  return row ? rowToCandidate(row) : null;
}

/** All clusters in the given lifecycle status, newest update first. */
export function listCandidatesByStatus(
  status: ProcCandidateStatus,
): ProcCandidate[] {
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT
        cluster_id AS clusterId,
        goal,
        member_note_slugs AS memberNoteSlugs,
        count,
        status,
        explicit,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM proc_candidates
      WHERE status = ?
      ORDER BY updated_at DESC
    `,
    )
    .all(status) as ProcCandidateRow[];
  return rows.map(rowToCandidate);
}

/** Move a cluster to a new lifecycle status and stamp `updated_at`. */
export function markCandidateStatus(
  clusterId: string,
  status: ProcCandidateStatus,
  at: number = Date.now(),
): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      UPDATE proc_candidates SET status = ?, updated_at = ?
      WHERE cluster_id = ?
    `,
    )
    .run(status, at, clusterId);
}

/**
 * Add a note slug to a cluster's member set (no-op when already present) and
 * stamp `updated_at`. No-op when the cluster is not registered.
 */
export function addMemberNote(
  clusterId: string,
  slug: string,
  at: number = Date.now(),
): void {
  const existing = getCandidate(clusterId);
  if (!existing) return;
  if (existing.memberNoteSlugs.includes(slug)) return;
  const next = [...existing.memberNoteSlugs, slug];
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      UPDATE proc_candidates SET member_note_slugs = ?, updated_at = ?
      WHERE cluster_id = ?
    `,
    )
    .run(JSON.stringify(next), at, clusterId);
}
