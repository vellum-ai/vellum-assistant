/**
 * Document revision history: snapshots of a document's title and body as they
 * stood at a revision, taken just before a write replaces that state.
 *
 * Snapshot writes run inside the caller's transaction, next to the document
 * write they precede, so a snapshot exists exactly when its write landed.
 */
import { rawAll, rawGet, rawRun } from "../persistence/raw-query.js";

/** Who made the write a snapshot was taken ahead of. */
export type DocumentRevisionAuthor = "user" | "assistant";

/** Snapshots kept per document; older ones are pruned on each insert. */
export const MAX_REVISIONS_PER_DOCUMENT = 100;

/**
 * A user save snapshots the prior state at most this often per document,
 * unless the latest snapshot preceded an assistant edit.
 */
export const USER_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export interface DocumentRevisionSummary {
  revision: number;
  author: DocumentRevisionAuthor;
  createdAt: number;
  wordCount: number;
  title: string;
}

export interface DocumentRevisionRecord extends DocumentRevisionSummary {
  content: string;
}

/** The document state a snapshot preserves. */
export interface DocumentSnapshotSource {
  surfaceId: string;
  revision: number;
  title: string;
  content: string;
  wordCount: number;
}

interface RevisionRow {
  revision: number;
  author: DocumentRevisionAuthor;
  created_at: number;
  word_count: number;
  title: string;
  content: string;
}

function mapRowToSummary(
  row: Omit<RevisionRow, "content">,
): DocumentRevisionSummary {
  return {
    revision: row.revision,
    author: row.author,
    createdAt: row.created_at,
    wordCount: row.word_count,
    title: row.title,
  };
}

/**
 * Store `state` as the snapshot for its revision and prune the document's
 * history to the newest {@link MAX_REVISIONS_PER_DOCUMENT}. A revision that is
 * already snapshotted keeps its first snapshot.
 */
export function recordDocumentSnapshot(
  state: DocumentSnapshotSource,
  author: DocumentRevisionAuthor,
): void {
  rawRun(
    "documentRevisions:record",
    /*sql*/ `INSERT OR IGNORE INTO document_revisions (surface_id, revision, title, content, word_count, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    state.surfaceId,
    state.revision,
    state.title,
    state.content,
    state.wordCount,
    author,
    Date.now(),
  );
  rawRun(
    "documentRevisions:prune",
    /*sql*/ `DELETE FROM document_revisions
     WHERE surface_id = ?
       AND revision NOT IN (
         SELECT revision FROM document_revisions
         WHERE surface_id = ?
         ORDER BY revision DESC
         LIMIT ?
       )`,
    state.surfaceId,
    state.surfaceId,
    MAX_REVISIONS_PER_DOCUMENT,
  );
}

/**
 * Whether a user save should snapshot the state it replaces: when the document
 * has no snapshot yet, when the latest one is older than
 * {@link USER_SNAPSHOT_INTERVAL_MS}, or when the latest one preceded an
 * assistant edit, so the assistant's result survives the user's next edits.
 */
export function shouldSnapshotBeforeUserSave(surfaceId: string): boolean {
  const latest = rawGet<{ author: string; created_at: number }>(
    "documentRevisions:latest",
    /*sql*/ `SELECT author, created_at FROM document_revisions
     WHERE surface_id = ?
     ORDER BY revision DESC
     LIMIT 1`,
    surfaceId,
  );
  if (!latest) {
    return true;
  }
  return (
    latest.author === "assistant" ||
    Date.now() - latest.created_at >= USER_SNAPSHOT_INTERVAL_MS
  );
}

/** A document's snapshots, newest first, without their bodies. */
export function listDocumentRevisions(
  surfaceId: string,
): DocumentRevisionSummary[] {
  return rawAll<Omit<RevisionRow, "content">>(
    "documentRevisions:list",
    /*sql*/ `SELECT revision, author, created_at, word_count, title
     FROM document_revisions
     WHERE surface_id = ?
     ORDER BY revision DESC`,
    surfaceId,
  ).map(mapRowToSummary);
}

/** One snapshot with its body, or `null` when it does not exist. */
export function getDocumentRevision(
  surfaceId: string,
  revision: number,
): DocumentRevisionRecord | null {
  const row = rawGet<RevisionRow>(
    "documentRevisions:get",
    /*sql*/ `SELECT revision, author, created_at, word_count, title, content
     FROM document_revisions
     WHERE surface_id = ? AND revision = ?`,
    surfaceId,
    revision,
  );
  return row ? { ...mapRowToSummary(row), content: row.content } : null;
}
