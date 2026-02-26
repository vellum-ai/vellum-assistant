import { getLogger } from '../util/logger.js';
import { rawGet, rawRun } from './db.js';

const log = getLogger('fts-reconciler');

export interface FtsReconciliationResult {
  table: string;
  baseCount: number;
  ftsCount: number;
  missingInserted: number;
  orphansRemoved: number;
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

  return { table: ftsTable, baseCount, ftsCount, missingInserted, orphansRemoved };
}

/**
 * Reconcile all FTS indexes. Returns results for each table so callers can
 * inspect what was repaired.
 */
export function reconcileFtsIndexes(): FtsReconciliationResult[] {
  const results: FtsReconciliationResult[] = [];

  // memory_segment_fts tracks memory_segments
  try {
    const result = reconcileTable({
      ftsTable: 'memory_segment_fts',
      ftsIdColumn: 'segment_id',
      ftsContentColumn: 'text',
      baseTable: 'memory_segments',
      baseIdColumn: 'id',
      baseContentColumn: 'text',
    });
    results.push(result);
    if (result.missingInserted > 0 || result.orphansRemoved > 0) {
      log.info(result, 'Reconciled memory_segment_fts');
    } else {
      log.debug(result, 'memory_segment_fts is in sync');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reconcile memory_segment_fts');
  }

  // messages_fts tracks messages
  try {
    const result = reconcileTable({
      ftsTable: 'messages_fts',
      ftsIdColumn: 'message_id',
      ftsContentColumn: 'content',
      baseTable: 'messages',
      baseIdColumn: 'id',
      baseContentColumn: 'content',
    });
    results.push(result);
    if (result.missingInserted > 0 || result.orphansRemoved > 0) {
      log.info(result, 'Reconciled messages_fts');
    } else {
      log.debug(result, 'messages_fts is in sync');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reconcile messages_fts');
  }

  return results;
}
