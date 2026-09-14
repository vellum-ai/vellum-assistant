import { desc, eq } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { getAcpSessionManager } from "./index.js";
import type { AcpSessionManager } from "./session-manager.js";
import type { AcpSessionState } from "./types.js";

const log = getLogger("acp:session-snapshot");

export interface AcpSessionSnapshot {
  id: string;
  agentId: string;
  acpSessionId: string;
  parentConversationId: string;
  status: string;
  startedAt: number;
  completedAt?: number | null;
  error?: string | null;
  stopReason?: string | null;
  task?: string;
  parentToolUseId?: string;
  authErrorCode?: string;
  authErrorCredential?: string;
  model?: string;
  availableModels?: AcpSessionState["availableModels"];
  modelRevisionEpoch?: string;
  modelRevision?: number;
  usedTokens?: number;
  contextSize?: number;
  costAmount?: number;
  costCurrency?: string;
  inputTokens?: number;
  outputTokens?: number;
  eventLog?: unknown[];
  source: "live" | "history";
  resumable: boolean;
  cwd?: string | null;
}

export interface AcpSessionSnapshotPage {
  sessions: AcpSessionSnapshot[];
  sawEveryHistoryRow: boolean;
}

interface SnapshotOptions {
  includeEventLog?: boolean;
}

function fromLiveState(
  state: AcpSessionState,
  manager: AcpSessionManager,
  opts: SnapshotOptions,
): AcpSessionSnapshot {
  return {
    id: state.id,
    agentId: state.agentId,
    acpSessionId: state.acpSessionId,
    parentConversationId: state.parentConversationId,
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt ?? null,
    error: state.error ?? null,
    stopReason: state.stopReason ?? null,
    task: state.task,
    parentToolUseId: state.parentToolUseId,
    authErrorCode: state.authErrorCode,
    authErrorCredential: state.authErrorCredential,
    model: state.model,
    availableModels: state.availableModels,
    modelRevisionEpoch: state.modelRevisionEpoch,
    modelRevision: state.modelRevision,
    usedTokens: state.latestUsage?.usedTokens,
    contextSize: state.latestUsage?.contextSize,
    costAmount: state.latestUsage?.costAmount,
    costCurrency: state.latestUsage?.costCurrency,
    inputTokens: state.latestUsage?.inputTokens,
    outputTokens: state.latestUsage?.outputTokens,
    eventLog: opts.includeEventLog
      ? manager.getBufferedUpdates(state.id)
      : undefined,
    source: "live",
    resumable: false,
  };
}

function isResumableHistoryRow(
  row: typeof acpSessionHistory.$inferSelect,
): boolean {
  return Boolean(row.cwd && row.acpSessionId);
}

export function snapshotHistoryRow(
  row: typeof acpSessionHistory.$inferSelect,
  opts: SnapshotOptions = { includeEventLog: true },
): AcpSessionSnapshot {
  let eventLog: unknown[] | undefined;
  if (opts.includeEventLog !== false) {
    eventLog = [];
    try {
      const parsed = JSON.parse(row.eventLogJson) as unknown;
      if (Array.isArray(parsed)) {
        eventLog = parsed;
      }
    } catch (err) {
      log.warn(
        { id: row.id, err },
        "Failed to parse event_log_json for ACP session history row",
      );
    }
  }

  return {
    id: row.id,
    agentId: row.agentId,
    acpSessionId: row.acpSessionId,
    parentConversationId: row.parentConversationId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    stopReason: row.stopReason,
    task: row.task ?? undefined,
    parentToolUseId: row.parentToolUseId ?? undefined,
    authErrorCode: row.authErrorCode ?? undefined,
    authErrorCredential: row.authErrorCredential ?? undefined,
    usedTokens: row.usedTokens ?? undefined,
    contextSize: row.contextSize ?? undefined,
    costAmount: row.costAmount ?? undefined,
    costCurrency: row.costCurrency ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    eventLog,
    source: "history",
    resumable: isResumableHistoryRow(row),
    cwd: row.cwd,
  };
}

export function getAcpSessionSnapshot(
  acpSessionId: string,
  opts: SnapshotOptions = {},
): AcpSessionSnapshot | undefined {
  const manager = getAcpSessionManager();
  const snapshotOptions = {
    includeEventLog: opts.includeEventLog ?? true,
  };
  const live = (manager.getStatus() as AcpSessionState[]).find(
    (state) => state.id === acpSessionId,
  );
  if (live) {
    return fromLiveState(live, manager, snapshotOptions);
  }

  const row = getDb()
    .select()
    .from(acpSessionHistory)
    .where(eq(acpSessionHistory.id, acpSessionId))
    .get();
  return row ? snapshotHistoryRow(row, snapshotOptions) : undefined;
}

export function listAcpSessionSnapshots(opts: {
  limit: number;
  conversationId?: string;
  includeEventLog?: boolean;
}): AcpSessionSnapshotPage {
  const manager = getAcpSessionManager();
  const inMemory = manager.getStatus() as AcpSessionState[];
  const snapshotOptions = {
    includeEventLog: opts.includeEventLog ?? true,
  };

  const merged = new Map<string, AcpSessionSnapshot>();
  for (const state of inMemory) {
    if (
      opts.conversationId &&
      state.parentConversationId !== opts.conversationId
    ) {
      continue;
    }
    merged.set(state.id, fromLiveState(state, manager, snapshotOptions));
  }

  const db = getDb();
  const baseQuery = db.select().from(acpSessionHistory);
  const filtered = opts.conversationId
    ? baseQuery.where(
        eq(acpSessionHistory.parentConversationId, opts.conversationId),
      )
    : baseQuery;
  const historyLimit = opts.limit + merged.size;
  const historyRows = filtered
    .orderBy(desc(acpSessionHistory.startedAt))
    .limit(historyLimit)
    .all();

  for (const row of historyRows) {
    if (!merged.has(row.id)) {
      merged.set(row.id, snapshotHistoryRow(row, snapshotOptions));
    }
  }

  return {
    sessions: Array.from(merged.values()).sort(
      (a, b) => b.startedAt - a.startedAt,
    ),
    sawEveryHistoryRow: historyRows.length < historyLimit,
  };
}
