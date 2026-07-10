/**
 * Gmail trigger poll. Runs as a script-mode schedule and escalates to the
 * assistant only when new inbox mail arrives. Gmail is read via
 * `assistant oauth request`, so no OAuth token ever touches this script.
 *
 * State is kept per mailbox, keyed by the email address /profile reports: a
 * historyId watermark plus a ledger of already-reported message ids. State
 * commits before the digest is escalated, so a retried or restarted run never
 * escalates the same message twice.
 *
 * Flags, baked into the schedule command at install:
 *   --account <email>    mailbox to poll; repeat to watch several. Omitted,
 *                        the single auto-resolved connection is polled.
 *   --lookback <dur>     first-sync backfill window (90m/4h/2d/1w or seconds)
 *   --action-prompt <s>  instruction for the woken assistant
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const workspace = process.env.VELLUM_WORKSPACE_DIR;
const scheduleId = process.env.__SCHEDULE_ID;
if (!workspace || !scheduleId) {
  console.error(
    "VELLUM_WORKSPACE_DIR and __SCHEDULE_ID must be set — run as a script-mode schedule.",
  );
  process.exit(1);
}

// State lives outside the skill dir so it survives skill reinstall.
const SCHEDULE_DIR = `${workspace}/schedules/${scheduleId}`;
const STATE_DIR = `${SCHEDULE_DIR}/state`;
const DB_FILE = `${STATE_DIR}/state.db`;
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 100;
// Per-account cap per poll. A poll that hits it stops paginating, reports
// truncated, and resumes from the un-advanced watermark next run.
const MAX_IDS = 1000;
const META_CAP = 200;
// Each metadata fetch forks a full assistant CLI process, so an unbounded
// fan-out can OOM a memory-limited host.
const META_CONCURRENCY = 6;
const DIGEST_CAP = 50;
const LEDGER_RETENTION_SEC = 30 * 86400;
const EXPIRY_CATCHUP_QUERY = "in:inbox newer_than:1d";
const DEFAULT_ACTION_PROMPT =
  "New email arrived in your inbox. Summarize what's new (sender + subject) and flag anything urgent or needing a reply.";

function parseLookbackSeconds(value: string): number {
  const m = /^(\d+)([smhdw]?)$/.exec(value.trim());
  if (!m) {
    console.error(
      `Invalid --lookback "${value}" — use e.g. 90m, 4h, 2d, 1w, or 0 to disable.`,
    );
    process.exit(1);
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

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1]?.trim();
  if (!value) {
    console.error(`${name} requires a value.`);
    process.exit(1);
  }
  return value;
}

function flagValues(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== name) continue;
    const value = process.argv[i + 1]?.trim();
    if (!value) {
      console.error(`${name} requires a value.`);
      process.exit(1);
    }
    values.push(value);
  }
  return values;
}

const lookbackFlag = flagValue("--lookback");
const lookbackSec =
  lookbackFlag !== undefined ? parseLookbackSeconds(lookbackFlag) : 0;
const accountFlags = flagValues("--account");
const actionPrompt = flagValue("--action-prompt") ?? DEFAULT_ACTION_PROMPT;

/** Run fn over items with at most `limit` in flight at once. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function ensureGitignore(): Promise<void> {
  const path = `${SCHEDULE_DIR}/.gitignore`;
  if (!existsSync(path)) await writeFile(path, "state/\n");
}

function openDb(): Database {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.exec(
    `CREATE TABLE IF NOT EXISTS accounts (
       email TEXT PRIMARY KEY,
       history_id TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS reported (
       account TEXT NOT NULL,
       id TEXT NOT NULL,
       reported_at INTEGER NOT NULL,
       PRIMARY KEY (account, id)
     );`,
  );
  return db;
}

function getAccountHistoryId(db: Database, email: string): string | null {
  const row = db
    .query<{ history_id: string }, [string]>(
      "SELECT history_id FROM accounts WHERE email = ?",
    )
    .get(email);
  return row?.history_id ?? null;
}

function filterUnreported(
  db: Database,
  email: string,
  ids: string[],
): string[] {
  const exists = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM reported WHERE account = ? AND id = ?",
  );
  return ids.filter((id) => !exists.get(email, id));
}

/** Advance one account's watermark and ledger atomically. Runs before escalation. */
function commitAccount(
  db: Database,
  email: string,
  historyId: string,
  ids: string[],
): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const insert = db.query(
    "INSERT OR IGNORE INTO reported (account, id, reported_at) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    db.query(
      "INSERT OR REPLACE INTO accounts (email, history_id) VALUES (?, ?)",
    ).run(email, historyId);
    for (const id of ids) insert.run(email, id, nowSec);
    db.query("DELETE FROM reported WHERE reported_at < ?").run(
      nowSec - LEDGER_RETENTION_SEC,
    );
  })();
}

class GmailStatusError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Gmail ${status}: ${body}`);
  }
}

async function gmailGet<T>(
  url: string,
  account: string | undefined,
): Promise<T> {
  const proc = Bun.spawn(
    [
      "assistant",
      "oauth",
      "request",
      "--provider",
      "google",
      ...(account ? ["--account", account] : []),
      url,
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let result: { ok: boolean; status: number; body: unknown };
  try {
    result = JSON.parse(out);
  } catch {
    throw new Error(
      `oauth request failed (exit ${code}): ${(err || out).slice(0, 200)}`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new GmailStatusError(
      result.status,
      JSON.stringify(result.body).slice(0, 200),
    );
  }
  return result.body as T;
}

async function cli<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["assistant", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `assistant ${args.slice(0, 2).join(" ")} exited ${code}: ${err.slice(0, 200)}`,
    );
  }
  return JSON.parse(out) as T;
}

async function getProfile(
  account: string | undefined,
): Promise<{ emailAddress: string; historyId: string }> {
  const profile = await gmailGet<{
    emailAddress?: string;
    historyId?: string | number;
  }>(`${GMAIL_BASE}/profile`, account);
  if (!profile.emailAddress || profile.historyId === undefined) {
    throw new Error("Gmail profile did not return emailAddress and historyId");
  }
  return {
    emailAddress: profile.emailAddress,
    historyId: String(profile.historyId),
  };
}

interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
}

/**
 * New INBOX message ids after the given historyId. With records, the returned
 * watermark is the last processed record's id, never the mailbox's current
 * historyId, which would skip the remainder of a truncated drain.
 */
async function listHistoryIds(
  startHistoryId: string,
  account: string | undefined,
): Promise<{ ids: string[]; watermark: string; truncated: boolean }> {
  const ids = new Set<string>();
  let watermark = startHistoryId;
  let sawRecords = false;
  let pageToken: string | undefined;
  let truncated = false;
  do {
    const page = await gmailGet<{
      history?: HistoryRecord[];
      nextPageToken?: string;
      historyId?: string | number;
    }>(
      `${GMAIL_BASE}/history?startHistoryId=${encodeURIComponent(startHistoryId)}` +
        `&historyTypes=messageAdded&labelId=INBOX&maxResults=${PAGE_SIZE}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      account,
    );
    for (const record of page.history ?? []) {
      sawRecords = true;
      for (const added of record.messagesAdded ?? []) ids.add(added.message.id);
      watermark = record.id;
    }
    if (!sawRecords && page.historyId !== undefined) {
      watermark = String(page.historyId);
    }
    pageToken = page.nextPageToken;
    if (ids.size >= MAX_IDS && pageToken) {
      truncated = true;
      pageToken = undefined;
    }
  } while (pageToken);
  return { ids: [...ids], watermark, truncated };
}

async function searchIds(
  q: string,
  account: string | undefined,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  do {
    const page = await gmailGet<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>(
      `${GMAIL_BASE}/messages?q=${encodeURIComponent(q)}&maxResults=${PAGE_SIZE}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      account,
    );
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
    if (ids.length >= MAX_IDS && pageToken) {
      truncated = true;
      pageToken = undefined;
    }
  } while (pageToken);
  return { ids: ids.slice(0, MAX_IDS), truncated };
}

function header(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

interface DigestEntry {
  account: string;
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  internalDate: number;
}

async function buildDigestEntries(
  ids: string[],
  account: string | undefined,
  email: string,
): Promise<DigestEntry[]> {
  const metaUrl = (id: string) =>
    `${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  return mapConcurrent(ids.slice(0, META_CAP), META_CONCURRENCY, async (id) => {
    const msg = await gmailGet<{
      id: string;
      threadId: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    }>(metaUrl(id), account);
    return {
      account: email,
      id: msg.id,
      threadId: msg.threadId,
      from: header(msg.payload?.headers, "From"),
      subject: header(msg.payload?.headers, "Subject"),
      date: header(msg.payload?.headers, "Date"),
      snippet: msg.snippet ?? "",
      internalDate: Number(msg.internalDate ?? 0),
    };
  });
}

/** Open a fresh conversation and wake it with the fenced digest. */
async function escalate(
  entries: DigestEntry[],
  totals: Array<{ account: string; new: number }>,
): Promise<string> {
  // Sort by internalDate; list and history order carry no guarantee.
  entries.sort((a, b) => b.internalDate - a.internalDate);
  const digest = entries.slice(0, DIGEST_CAP);
  const total = totals.reduce((n, t) => n + t.new, 0);
  const conv = await cli<{ ok: boolean; id: string }>([
    "conversations",
    "new",
    "Gmail Triggers",
    "--json",
  ]);
  const wake = await cli<{ invoked: boolean; reason?: string }>([
    "conversations",
    "wake",
    conv.id,
    "--source",
    "gmail-trigger",
    "--hint",
    actionPrompt,
    "--external-content",
    JSON.stringify({
      total,
      showing: digest.length,
      accounts: totals,
      messages: digest,
    }),
    "--json",
  ]);
  // A skipped wake exits 0 with invoked:false; treating it as success would
  // report ok while the digest was never delivered.
  if (!wake.invoked) {
    throw new Error(
      `wake skipped (${wake.reason ?? "unknown"}) — digest of ${total} message(s) was not delivered`,
    );
  }
  return conv.id;
}

function friendlyError(err: unknown): string {
  if (
    err instanceof GmailStatusError &&
    (err.status === 401 || err.status === 403)
  ) {
    return `Google authorization failed (HTTP ${err.status}). Gmail Triggers cannot read this mailbox until the Google connection is repaired — reconnect Google and it resumes on its own.`;
  }
  return String((err as Error)?.message ?? err);
}

interface AccountResult {
  account: string;
  new: number;
  baselined?: boolean;
  rebaselined?: boolean;
  truncated?: boolean;
  error?: string;
}

async function syncAccount(
  db: Database,
  account: string | undefined,
): Promise<{ result: AccountResult; entries: DigestEntry[] }> {
  const profile = await getProfile(account);
  const email = profile.emailAddress;
  const stored = getAccountHistoryId(db, email);

  if (!stored) {
    // First sight of this mailbox. Baseline at its current historyId,
    // backfilling the lookback window once if one was requested.
    let ids: string[] = [];
    let truncated = false;
    if (lookbackSec > 0) {
      const since = Math.floor(Date.now() / 1000) - lookbackSec;
      ({ ids, truncated } = await searchIds(
        `in:inbox after:${since}`,
        account,
      ));
    }
    commitAccount(db, email, profile.historyId, ids);
    const entries =
      ids.length > 0 ? await buildDigestEntries(ids, account, email) : [];
    return {
      result: { account: email, new: ids.length, baselined: true, truncated },
      entries,
    };
  }

  let ids: string[];
  let watermark: string;
  let truncated = false;
  let rebaselined = false;
  try {
    ({ ids, watermark, truncated } = await listHistoryIds(stored, account));
  } catch (err) {
    if (err instanceof GmailStatusError && err.status === 404) {
      // The stored historyId expired. Re-baseline and catch up by search;
      // the ledger absorbs the overlap.
      rebaselined = true;
      watermark = profile.historyId;
      ({ ids, truncated } = await searchIds(EXPIRY_CATCHUP_QUERY, account));
    } else {
      throw err;
    }
  }

  const fresh = filterUnreported(db, email, ids);
  commitAccount(db, email, watermark, fresh);
  const entries =
    fresh.length > 0 ? await buildDigestEntries(fresh, account, email) : [];
  return {
    result: { account: email, new: fresh.length, truncated, rebaselined },
    entries,
  };
}

async function main(): Promise<void> {
  const db = openDb();
  await ensureGitignore();

  // One account's failure must not block the others.
  const passes: Array<string | undefined> =
    accountFlags.length > 0 ? accountFlags : [undefined];
  const results: AccountResult[] = [];
  const entries: DigestEntry[] = [];
  let anyError = false;

  for (const account of passes) {
    try {
      const synced = await syncAccount(db, account);
      results.push(synced.result);
      entries.push(...synced.entries);
    } catch (err) {
      anyError = true;
      results.push({
        account: account ?? "(default connection)",
        new: 0,
        error: friendlyError(err),
      });
    }
  }

  let conversationId: string | undefined;
  if (entries.length > 0) {
    const totals = results
      .filter((r) => r.new > 0)
      .map((r) => ({ account: r.account, new: r.new }));
    conversationId = await escalate(entries, totals);
  }

  console.log(
    JSON.stringify({
      ok: !anyError,
      new: results.reduce((n, r) => n + r.new, 0),
      accounts: results,
      conversationId,
    }),
  );
  if (anyError) process.exit(1);
}

main().catch((err) => {
  console.error(friendlyError(err));
  process.exit(1);
});
