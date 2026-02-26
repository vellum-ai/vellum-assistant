import { getLogger } from '../util/logger.js';
import { rawGet, rawRun } from './db.js';

const log = getLogger('fts-reconciler');

export interface FtsReconciliationResult {
  table: string;
  baseCount: number;
  ftsCount: number;
  missingInserted: number;
  orphansRemoved: number;
  staleRefreshed: number;
}

/**
 * Reconcile a single FTS index against its base table. Detects missing entries
 * (rows in the base table with no corresponding FTS row) and orphaned entries
 * (FTS rows whose base table row no longer exists), then repairs both.
 *
 * This is lighter than a full rebuild — it only touches the delta rather than
 * wiping and re-inserting the entire index.
 */
function reconcileTable(opts: {
  ftsTable: string;
  ftsIdColumn: string;
  ftsContentColumn: string;
  baseTable: string;
  baseIdColumn: string;
  baseContentColumn: string;
}): FtsReconciliationResult {
  const { ftsTable, ftsIdColumn, ftsContentColumn, baseTable, baseIdColumn, baseContentColumn } = opts;

  const baseCount = (rawGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${baseTable}`) ?? { c: 0 }).c;
  const ftsCount = (rawGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${ftsTable}`) ?? { c: 0 }).c;

  // Find base table rows missing from the FTS index
  const missingInserted = rawRun(/*sql*/ `
    INSERT INTO ${ftsTable}(${ftsIdColumn}, ${ftsContentColumn})
    SELECT b.${baseIdColumn}, b.${baseContentColumn}
    FROM ${baseTable} b
    LEFT JOIN ${ftsTable} f ON f.${ftsIdColumn} = b.${baseIdColumn}
    WHERE f.${ftsIdColumn} IS NULL
  `);

  // Find FTS rows whose base table row no longer exists
  const orphansRemoved = rawRun(/*sql*/ `
    DELETE FROM ${ftsTable}
    WHERE ${ftsIdColumn} IN (
      SELECT f.${ftsIdColumn}
      FROM ${ftsTable} f
      LEFT JOIN ${baseTable} b ON b.${baseIdColumn} = f.${ftsIdColumn}
      WHERE b.${baseIdColumn} IS NULL
    )
  `);

  // Refresh FTS rows whose content is stale (base row was updated but the
  // update trigger didn't fire or was missing). Delete-then-insert is the
  // standard FTS5 update pattern.
  const staleDeleted = rawRun(/*sql*/ `
    DELETE FROM ${ftsTable}
    WHERE ${ftsIdColumn} IN (
      SELECT f.${ftsIdColumn}
      FROM ${ftsTable} f
      JOIN ${baseTable} b ON b.${baseIdColumn} = f.${ftsIdColumn}
      WHERE b.${baseContentColumn} IS NOT f.${ftsContentColumn}
    )
  `);
  if (staleDeleted > 0) {
    rawRun(/*sql*/ `
      INSERT INTO ${ftsTable}(${ftsIdColumn}, ${ftsContentColumn})
      SELECT b.${baseIdColumn}, b.${baseContentColumn}
      FROM ${baseTable} b
      LEFT JOIN ${ftsTable} f ON f.${ftsIdColumn} = b.${baseIdColumn}
      WHERE f.${ftsIdColumn} IS NULL
    `);
  }

  return { table: ftsTable, baseCount, ftsCount, missingInserted, orphansRemoved, staleRefreshed: staleDeleted };
}

/**
 * Reconcile all FTS indexes. Returns results for each table so callers can
 * inspect what was repaired.
 */
export function reconcileFtsIndexes(): FtsReconciliationResult[] {
  const results: FtsReconciliationResult[] = [];

  // memory_segment_fts tracks memory_segments
  try {
    const memResult = reconcileTable({
      ftsTable: 'memory_segment_fts',
      ftsIdColumn: 'segment_id',
      ftsContentColumn: 'text',
      baseTable: 'memory_segments',
      baseIdColumn: 'id',
      baseContentColumn: 'text',
    });
    results.push(memResult);
    if (memResult.missingInserted > 0 || memResult.orphansRemoved > 0 || memResult.staleRefreshed > 0) {
      log.info(memResult, 'Reconciled memory_segment_fts');
    } else {
      log.debug(memResult, 'memory_segment_fts is in sync');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reconcile memory_segment_fts');
  }

  // messages_fts tracks messages
  try {
    const msgResult = reconcileTable({
      ftsTable: 'messages_fts',
      ftsIdColumn: 'message_id',
      ftsContentColumn: 'content',
      baseTable: 'messages',
      baseIdColumn: 'id',
      baseContentColumn: 'content',
    });
    results.push(msgResult);
    if (msgResult.missingInserted > 0 || msgResult.orphansRemoved > 0 || msgResult.staleRefreshed > 0) {
      log.info(msgResult, 'Reconciled messages_fts');
    } else {
      log.debug(msgResult, 'messages_fts is in sync');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reconcile messages_fts');
  }

  return results;
}
