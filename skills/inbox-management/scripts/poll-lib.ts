/**
 * Pure helpers for the inbox-management poll. Kept free of process.exit and
 * workspace env so unit tests can import them without running a schedule.
 */

export const PIPELINE_HINT =
  "Load the inbox-management skill and run the inbox management pipeline on the new messages in the attached digest only. Do not re-scan the rest of the inbox or re-judge mail that is not in this digest.";

export const DIGEST_CAP = 50;
export const LEDGER_RETENTION_SEC = 30 * 86400;
export const FOLLOWUP_MIN_AGE_MS = 2 * 86400 * 1000;
export const FOLLOWUP_MAX_AGE_MS = 14 * 86400 * 1000;

export type MailBucket = "inbox" | "sent" | "both" | "ignore";

export interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId?: string } }>;
}

export interface FollowupCandidate {
  id: string;
  threadId: string;
  sentAt: number;
  subject: string;
}

export interface PollAccountState {
  historyId: string;
  reported: Record<string, number>;
  pending: string[];
  followups: FollowupCandidate[];
}

export interface PollState {
  accounts: Record<string, PollAccountState>;
}

export function emptyAccount(historyId = ""): PollAccountState {
  return { historyId, reported: {}, pending: [], followups: [] };
}

export function emptyState(): PollState {
  return { accounts: {} };
}

export function accountState(
  state: PollState,
  email: string,
): PollAccountState {
  const existing = state.accounts[email];
  if (existing) {
    return existing;
  }
  const created = emptyAccount();
  state.accounts[email] = created;
  return created;
}

export function parsePollState(raw: unknown): PollState {
  const state = emptyState();
  if (!raw || typeof raw !== "object") {
    return state;
  }
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (!accounts || typeof accounts !== "object") {
    return state;
  }
  for (const [email, value] of Object.entries(
    accounts as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const row = value as Partial<PollAccountState>;
    state.accounts[email] = {
      historyId: typeof row.historyId === "string" ? row.historyId : "",
      reported:
        row.reported && typeof row.reported === "object" ? row.reported : {},
      pending: Array.isArray(row.pending)
        ? row.pending.filter((id): id is string => typeof id === "string")
        : [],
      followups: Array.isArray(row.followups)
        ? row.followups.filter(isFollowupCandidate)
        : [],
    };
  }
  return state;
}

function isFollowupCandidate(value: unknown): value is FollowupCandidate {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<FollowupCandidate>;
  return (
    typeof row.id === "string" &&
    typeof row.threadId === "string" &&
    typeof row.sentAt === "number" &&
    typeof row.subject === "string"
  );
}

export function parseLookbackSeconds(value: string): number {
  const m = /^(\d+)([smhdw]?)$/.exec(value.trim());
  if (!m) {
    throw new Error(
      `Invalid --lookback "${value}": use e.g. 90m, 4h, 2d, 1w, or 0 to disable.`,
    );
  }
  const units: Record<string, number> = {
    "": 1,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  return Number(m[1]) * units[m[2]];
}

export function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) {
    return undefined;
  }
  const value = argv[idx + 1]?.trim();
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function flagValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) {
      continue;
    }
    const value = argv[i + 1]?.trim();
    if (!value) {
      throw new Error(`${name} requires a value.`);
    }
    values.push(value);
  }
  return values;
}

/** New message ids from a Gmail history page, plus the last record id. */
export function collectAddedMessageIds(history: HistoryRecord[]): {
  ids: string[];
  lastRecordId: string | null;
} {
  const ids = new Set<string>();
  let lastRecordId: string | null = null;
  for (const record of history) {
    for (const added of record.messagesAdded ?? []) {
      ids.add(added.message.id);
    }
    lastRecordId = record.id;
  }
  return { ids: [...ids], lastRecordId };
}

export function classifyLabelIds(labelIds: string[] | undefined): MailBucket {
  const labels = new Set(labelIds ?? []);
  const inbox = labels.has("INBOX");
  const sent = labels.has("SENT");
  if (inbox && sent) {
    return "both";
  }
  if (inbox) {
    return "inbox";
  }
  if (sent) {
    return "sent";
  }
  return "ignore";
}

/** New inbox mail is judged now. Sent-only mail is aged for a later follow-up. */
export function isImmediateWork(bucket: MailBucket): boolean {
  return bucket === "inbox" || bucket === "both";
}

export function isSentCandidate(bucket: MailBucket): boolean {
  return bucket === "sent" || bucket === "both";
}

export function shouldEscalate(
  entries: Array<{ bucket: MailBucket }>,
  dueFollowupCount = 0,
): boolean {
  return (
    entries.some((entry) => isImmediateWork(entry.bucket)) ||
    dueFollowupCount > 0
  );
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function filterUnreported(
  account: PollAccountState,
  ids: string[],
): string[] {
  return ids.filter((id) => account.reported[id] === undefined);
}

export function markReported(
  account: PollAccountState,
  ids: string[],
  nowSec: number,
): void {
  for (const id of ids) {
    if (account.reported[id] === undefined) {
      account.reported[id] = nowSec;
    }
  }
}

export function pruneReported(
  account: PollAccountState,
  nowSec: number,
  retentionSec = LEDGER_RETENTION_SEC,
): void {
  const cutoff = nowSec - retentionSec;
  for (const [id, at] of Object.entries(account.reported)) {
    if (at < cutoff) {
      delete account.reported[id];
    }
  }
}

export function rememberFollowups(
  account: PollAccountState,
  candidates: FollowupCandidate[],
): void {
  const byId = new Map(account.followups.map((row) => [row.id, row]));
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  account.followups = [...byId.values()];
}

export function dropFollowups(account: PollAccountState, ids: string[]): void {
  const drop = new Set(ids);
  account.followups = account.followups.filter((row) => !drop.has(row.id));
}

export function dueFollowups(
  followups: FollowupCandidate[],
  nowMs: number,
  minAgeMs = FOLLOWUP_MIN_AGE_MS,
  maxAgeMs = FOLLOWUP_MAX_AGE_MS,
): FollowupCandidate[] {
  return followups.filter((row) => {
    const age = nowMs - row.sentAt;
    return age >= minAgeMs && age <= maxAgeMs;
  });
}

export function expiredFollowups(
  followups: FollowupCandidate[],
  nowMs: number,
  maxAgeMs = FOLLOWUP_MAX_AGE_MS,
): FollowupCandidate[] {
  return followups.filter((row) => nowMs - row.sentAt > maxAgeMs);
}

/**
 * Follow-ups first, then new inbox mail. Overflow ids stay pending so a later
 * poll can deliver them. Follow-ups that do not fit stay in the follow-up list.
 */
export function takeDigestSlice<T extends { id: string }>(
  followups: T[],
  inbox: T[],
  cap = DIGEST_CAP,
): { delivered: T[]; overflowIds: string[] } {
  const delivered: T[] = [];
  const overflowIds: string[] = [];
  for (const entry of followups) {
    if (delivered.length < cap) {
      delivered.push(entry);
    }
  }
  for (const entry of inbox) {
    if (delivered.length < cap) {
      delivered.push(entry);
    } else {
      overflowIds.push(entry.id);
    }
  }
  return { delivered, overflowIds };
}
