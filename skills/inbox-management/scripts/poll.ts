/**
 * Inbox-management poll. Runs as a script-mode schedule and wakes the
 * assistant only when there is new inbox mail or a sent thread that has
 * become stale. Gmail is read via `assistant oauth request`.
 *
 * State is a JSON file next to the schedule (same idea as gmail-prefs), not
 * a SQLite database. Watermark, pending overflow ids, and follow-up
 * candidates live there. Delivered digest ids are marked reported only after
 * a successful wake so overflow and failed wakes are retried.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import {
  DIGEST_CAP,
  PIPELINE_HINT,
  accountState,
  classifyLabelIds,
  collectAddedMessageIds,
  dropFollowups,
  dueFollowups,
  expiredFollowups,
  filterUnreported,
  flagValue,
  flagValues,
  isImmediateWork,
  isSentCandidate,
  markReported,
  parseLookbackSeconds,
  parsePollState,
  pruneReported,
  rememberFollowups,
  takeDigestSlice,
  uniqueIds,
  type FollowupCandidate,
  type MailBucket,
  type PollState,
} from "./poll-lib.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 100;
const MAX_IDS = 1000;
const META_CAP = 200;
const META_CONCURRENCY = 6;
const EXPIRY_CATCHUP_QUERY = "(in:inbox OR in:sent) newer_than:1d";
const STATE_FILE = "state.json";

function workspaceEnv(): { workspace: string; scheduleId: string } {
  const workspace = process.env.VELLUM_WORKSPACE_DIR;
  const scheduleId = process.env.__SCHEDULE_ID;
  if (!workspace || !scheduleId) {
    throw new Error(
      "VELLUM_WORKSPACE_DIR and __SCHEDULE_ID must be set. Run as a script-mode schedule.",
    );
  }
  return { workspace, scheduleId };
}

function parseLookbackFlag(argv: string[]): number {
  const lookbackFlag = flagValue(argv, "--lookback");
  if (lookbackFlag === undefined) {
    return 0;
  }
  return parseLookbackSeconds(lookbackFlag);
}

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

async function ensureGitignore(scheduleDir: string): Promise<void> {
  const path = `${scheduleDir}/.gitignore`;
  if (!existsSync(path)) {
    await writeFile(path, "state/\n");
  }
}

function statePath(stateDir: string): string {
  return `${stateDir}/${STATE_FILE}`;
}

function loadState(stateDir: string): PollState {
  mkdirSync(stateDir, { recursive: true });
  const path = statePath(stateDir);
  if (!existsSync(path)) {
    return parsePollState(null);
  }
  try {
    return parsePollState(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return parsePollState(null);
  }
}

function saveState(stateDir: string, state: PollState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
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
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
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
    windowsHide: true,
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
      history?: Array<{
        id: string;
        messagesAdded?: Array<{ message: { id: string } }>;
      }>;
      nextPageToken?: string;
      historyId?: string | number;
    }>(
      `${GMAIL_BASE}/history?startHistoryId=${encodeURIComponent(startHistoryId)}` +
        `&historyTypes=messageAdded&maxResults=${PAGE_SIZE}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      account,
    );
    const collected = collectAddedMessageIds(page.history ?? []);
    for (const id of collected.ids) {
      ids.add(id);
    }
    if (collected.lastRecordId) {
      sawRecords = true;
      watermark = collected.lastRecordId;
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
  bucket: MailBucket;
  kind: "new" | "followup";
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
      labelIds?: string[];
      payload?: { headers?: Array<{ name: string; value: string }> };
    }>(metaUrl(id), account);
    const labelIds = msg.labelIds ?? [];
    return {
      account: email,
      id: msg.id,
      threadId: msg.threadId,
      from: header(msg.payload?.headers, "From"),
      subject: header(msg.payload?.headers, "Subject"),
      date: header(msg.payload?.headers, "Date"),
      snippet: msg.snippet ?? "",
      internalDate: Number(msg.internalDate ?? 0),
      bucket: classifyLabelIds(labelIds),
      kind: "new" as const,
    };
  });
}

async function latestThreadMessageId(
  threadId: string,
  account: string | undefined,
): Promise<string | null> {
  try {
    const thread = await gmailGet<{
      messages?: Array<{ id: string }>;
    }>(`${GMAIL_BASE}/threads/${threadId}?format=minimal`, account);
    const messages = thread.messages ?? [];
    return messages.length > 0 ? messages[messages.length - 1].id : null;
  } catch (err) {
    if (err instanceof GmailStatusError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

async function escalate(payload: {
  delivered: DigestEntry[];
  followups: DigestEntry[];
  inbox: DigestEntry[];
  pending: number;
}): Promise<string> {
  const conv = await cli<{ ok: boolean; id: string }>([
    "conversations",
    "new",
    "Inbox Management",
    "--json",
  ]);
  const wake = await cli<{ invoked: boolean; reason?: string }>([
    "conversations",
    "wake",
    conv.id,
    "--source",
    "inbox-management",
    "--hint",
    PIPELINE_HINT,
    "--external-content",
    JSON.stringify({
      total: payload.delivered.length,
      showing: payload.delivered.length,
      pending: payload.pending,
      followups: payload.followups,
      inbox: payload.inbox,
      messages: payload.delivered,
    }),
    "--json",
  ]);
  if (!wake.invoked) {
    throw new Error(
      `wake skipped (${wake.reason ?? "unknown"}): digest of ${payload.delivered.length} message(s) was not delivered`,
    );
  }
  return conv.id;
}

function friendlyError(err: unknown): string {
  if (
    err instanceof GmailStatusError &&
    (err.status === 401 || err.status === 403)
  ) {
    return `Google authorization failed (HTTP ${err.status}). Inbox management cannot read this mailbox until the Google connection is repaired. Reconnect Google and it resumes on its own.`;
  }
  return String((err as Error)?.message ?? err);
}

interface AccountResult {
  account: string;
  new: number;
  followups: number;
  pending: number;
  baselined?: boolean;
  rebaselined?: boolean;
  truncated?: boolean;
  error?: string;
}

interface AccountSync {
  email: string;
  oauthAccount: string | undefined;
  result: AccountResult;
  inbox: DigestEntry[];
  dueFollowups: FollowupCandidate[];
  unbuiltIds: string[];
}

async function syncAccount(
  state: PollState,
  oauthAccount: string | undefined,
  lookbackSec: number,
  nowMs: number,
): Promise<AccountSync> {
  const profile = await getProfile(oauthAccount);
  const email = profile.emailAddress;
  const account = accountState(state, email);
  const nowSec = Math.floor(nowMs / 1000);
  pruneReported(account, nowSec);

  let ids: string[] = [];
  let truncated = false;
  let baselined = false;
  let rebaselined = false;

  if (!account.historyId) {
    baselined = true;
    account.historyId = profile.historyId;
    if (lookbackSec > 0) {
      const since = Math.floor(nowMs / 1000) - lookbackSec;
      ({ ids, truncated } = await searchIds(
        `(in:inbox OR in:sent) after:${since}`,
        oauthAccount,
      ));
    }
  } else {
    let watermark = account.historyId;
    try {
      ({ ids, watermark, truncated } = await listHistoryIds(
        account.historyId,
        oauthAccount,
      ));
    } catch (err) {
      if (err instanceof GmailStatusError && err.status === 404) {
        rebaselined = true;
        watermark = profile.historyId;
        ({ ids, truncated } = await searchIds(
          EXPIRY_CATCHUP_QUERY,
          oauthAccount,
        ));
      } else {
        throw err;
      }
    }
    account.historyId = watermark;
  }

  const fresh = filterUnreported(account, ids);
  const workIds = uniqueIds([...account.pending, ...fresh]).filter(
    (id) => account.reported[id] === undefined,
  );
  const built =
    workIds.length > 0
      ? await buildDigestEntries(workIds, oauthAccount, email)
      : [];

  const builtIds = new Set(built.map((entry) => entry.id));
  const unbuiltIds = workIds.filter((id) => !builtIds.has(id));
  const inbox = built.filter((entry) => isImmediateWork(entry.bucket));
  const sent = built.filter((entry) => isSentCandidate(entry.bucket));
  rememberFollowups(
    account,
    sent.map((entry) => ({
      id: entry.id,
      threadId: entry.threadId,
      sentAt: entry.internalDate || nowMs,
      subject: entry.subject,
    })),
  );
  dropFollowups(
    account,
    expiredFollowups(account.followups, nowMs).map((row) => row.id),
  );

  const due: FollowupCandidate[] = [];
  const replied: string[] = [];
  for (const candidate of dueFollowups(account.followups, nowMs)) {
    const latest = await latestThreadMessageId(
      candidate.threadId,
      oauthAccount,
    );
    if (latest !== candidate.id) {
      replied.push(candidate.id);
      continue;
    }
    due.push(candidate);
  }
  dropFollowups(account, replied);

  return {
    email,
    oauthAccount,
    result: {
      account: email,
      new: inbox.length,
      followups: due.length,
      pending: 0,
      baselined,
      rebaselined,
      truncated,
    },
    inbox,
    dueFollowups: due,
    unbuiltIds,
  };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const { workspace, scheduleId } = workspaceEnv();
  const scheduleDir = `${workspace}/schedules/${scheduleId}`;
  const stateDir = `${scheduleDir}/state`;
  const lookbackSec = parseLookbackFlag(argv);
  const accountFlags = flagValues(argv, "--account");
  const nowMs = Date.now();

  await ensureGitignore(scheduleDir);
  const state = loadState(stateDir);

  const passes: Array<string | undefined> =
    accountFlags.length > 0 ? accountFlags : [undefined];
  const results: AccountResult[] = [];
  const syncs: AccountSync[] = [];
  let anyError = false;

  for (const oauthAccount of passes) {
    try {
      const synced = await syncAccount(state, oauthAccount, lookbackSec, nowMs);
      syncs.push(synced);
    } catch (err) {
      anyError = true;
      results.push({
        account: oauthAccount ?? "(default connection)",
        new: 0,
        followups: 0,
        pending: 0,
        error: friendlyError(err),
      });
    }
  }

  const inbox = syncs
    .flatMap((row) => row.inbox)
    .sort((a, b) => b.internalDate - a.internalDate);
  const followupEntries: DigestEntry[] = syncs.flatMap((row) =>
    row.dueFollowups.map((candidate) => ({
      account: row.email,
      id: candidate.id,
      threadId: candidate.threadId,
      from: "",
      subject: candidate.subject,
      date: new Date(candidate.sentAt).toISOString(),
      snippet: "",
      internalDate: candidate.sentAt,
      bucket: "sent" as const,
      kind: "followup" as const,
    })),
  );
  const { delivered, overflowIds } = takeDigestSlice(
    followupEntries,
    inbox,
    DIGEST_CAP,
  );
  const overflow = new Set(overflowIds);
  const deliveredIds = new Set(delivered.map((entry) => entry.id));

  for (const synced of syncs) {
    const account = accountState(state, synced.email);
    const accountOverflow = synced.inbox
      .map((entry) => entry.id)
      .filter((id) => overflow.has(id));
    const accountDelivered = synced.inbox
      .map((entry) => entry.id)
      .filter((id) => deliveredIds.has(id))
      .concat(
        synced.dueFollowups
          .map((row) => row.id)
          .filter((id) => deliveredIds.has(id)),
      );
    account.pending = uniqueIds([
      ...accountDelivered,
      ...accountOverflow,
      ...synced.unbuiltIds,
    ]);
    synced.result.pending = accountOverflow.length + synced.unbuiltIds.length;
    results.push(synced.result);
  }
  saveState(stateDir, state);

  let conversationId: string | undefined;
  if (delivered.length > 0) {
    try {
      conversationId = await escalate({
        delivered,
        followups: delivered.filter((entry) => entry.kind === "followup"),
        inbox: delivered.filter((entry) => entry.kind === "new"),
        pending: overflowIds.length,
      });
      const nowSec = Math.floor(nowMs / 1000);
      for (const synced of syncs) {
        const account = accountState(state, synced.email);
        const deliveredForAccount = delivered
          .filter((entry) => entry.account === synced.email)
          .map((entry) => entry.id);
        markReported(account, deliveredForAccount, nowSec);
        account.pending = account.pending.filter(
          (id) => !deliveredForAccount.includes(id),
        );
        dropFollowups(
          account,
          deliveredForAccount.filter((id) =>
            synced.dueFollowups.some((row) => row.id === id),
          ),
        );
        pruneReported(account, nowSec);
      }
      saveState(stateDir, state);
    } catch (err) {
      anyError = true;
      console.error(friendlyError(err));
    }
  }

  console.log(
    JSON.stringify({
      ok: !anyError,
      new: results.reduce((n, r) => n + r.new, 0),
      followups: results.reduce((n, r) => n + r.followups, 0),
      pending: results.reduce((n, r) => n + r.pending, 0),
      accounts: results,
      conversationId,
    }),
  );
  if (anyError) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(friendlyError(err));
    process.exit(1);
  });
}
