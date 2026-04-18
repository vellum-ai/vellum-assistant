#!/usr/bin/env bun

/**
 * Gmail archive operations.
 * Supports 4 resolution paths: --query, --cache-key + --sender-emails,
 * --message-ids (batch), and --message-id (single).
 */

import {
  parseArgs,
  printError,
  ok,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import { gmailGet, gmailPost } from "./lib/gmail-client.js";
import { addToBlocklist } from "./gmail-prefs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_MODIFY_LIMIT = 1000;
const MAX_MESSAGES = 5000;

// ---------------------------------------------------------------------------
// UI confirmation helper
// ---------------------------------------------------------------------------

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const args = [
    "assistant",
    "ui",
    "confirm",
    "--title",
    opts.title,
    "--message",
    opts.message,
    "--confirm-label",
    opts.confirmLabel ?? "Confirm",
    "--json",
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist archived sender emails to the blocklist.
 * Filters for valid email addresses and wraps in try/catch for non-fatal errors.
 */
function recordBlocklist(senderEmails: string[]): void {
  const validEmails = senderEmails.filter((e) => e.includes("@"));
  if (validEmails.length === 0) return;

  try {
    addToBlocklist(validEmails);
  } catch {
    // Non-fatal — preferences are best-effort
  }
}

/** Batch modify messages in chunks of BATCH_MODIFY_LIMIT. */
async function batchArchive(
  messageIds: string[],
  account?: string,
): Promise<void> {
  for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
    const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);
    const resp = await gmailPost(
      "/messages/batchModify",
      { ids: chunk, removeLabelIds: ["INBOX"] },
      account,
    );
    if (!resp.ok) {
      throw new Error(
        `batchModify failed (status ${resp.status}): ${JSON.stringify(resp.data)}`,
      );
    }
  }
}

/** Paginate Gmail message search, collecting all message IDs up to MAX_MESSAGES. */
async function collectMessageIds(
  query: string,
  account?: string,
): Promise<string[]> {
  const allIds: string[] = [];
  let pageToken: string | undefined;

  while (allIds.length < MAX_MESSAGES) {
    const queryParams: Record<string, string> = {
      q: query,
      maxResults: "500",
    };
    if (pageToken) queryParams.pageToken = pageToken;

    const resp = await gmailGet<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>("/messages", queryParams, account);

    if (!resp.ok) {
      throw new Error(
        `Gmail search failed (status ${resp.status}): ${JSON.stringify(resp.data)}`,
      );
    }

    const ids = (resp.data.messages ?? []).map((m) => m.id);
    if (ids.length === 0) break;
    allIds.push(...ids);

    pageToken = resp.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  return allIds;
}

// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------

/** Path 1: --query — search Gmail and archive all matching messages. */
async function archiveByQuery(
  query: string,
  account?: string,
  skipConfirm?: boolean,
): Promise<void> {
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive all messages matching query: ${query}`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "query", reason: "User did not confirm" });
      return;
    }
  }

  const messageIds = await collectMessageIds(query, account);

  if (messageIds.length === 0) {
    ok({ archived: 0, method: "query", note: "No messages matched the query" });
    return;
  }

  await batchArchive(messageIds, account);
  ok({ archived: messageIds.length, method: "query" });
}

/** Path 2: --cache-key + --sender-emails — retrieve from cache, fall back to per-sender query. */
async function archiveByCacheKey(
  cacheKey: string,
  senderEmails: string[],
  account?: string,
  skipConfirm?: boolean,
): Promise<void> {
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive messages from ${senderEmails.length} sender(s)`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "cache", reason: "User did not confirm" });
      return;
    }
  }

  // Attempt to retrieve cached data
  let cachedData: Record<string, string[]> | null = null;

  try {
    const proc = Bun.spawn(
      ["assistant", "cache", "get", cacheKey, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const parsed = JSON.parse(stdout);
    if (parsed.ok === true && parsed.data !== null && parsed.data !== undefined) {
      cachedData = parsed.data as Record<string, string[]>;
    }
  } catch {
    // Cache miss — will fall back to per-sender query
  }

  const allMessageIds: string[] = [];

  if (cachedData !== null) {
    // Look up message IDs for each sender email from the cached data
    for (const email of senderEmails) {
      const ids = cachedData[email];
      if (Array.isArray(ids)) {
        allMessageIds.push(...ids);
      }
    }
  }

  if (cachedData === null || allMessageIds.length === 0) {
    // Fall back to per-sender query-based archiving
    for (const email of senderEmails) {
      const sanitized = email.replace(/"/g, "");
      const query = `from:"${sanitized}" in:inbox`;
      const ids = await collectMessageIds(query, account);
      allMessageIds.push(...ids);
      if (allMessageIds.length >= MAX_MESSAGES) break;
    }
  }

  if (allMessageIds.length === 0) {
    ok({ archived: 0, method: "cache", note: "No messages found" });
    return;
  }

  await batchArchive(allMessageIds, account);
  recordBlocklist(senderEmails);
  ok({ archived: allMessageIds.length, method: "cache" });
}

/** Path 3: --message-ids — direct batch archive. */
async function archiveByMessageIds(
  messageIds: string[],
  account?: string,
  skipConfirm?: boolean,
): Promise<void> {
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Archive messages",
      message: `Archive ${messageIds.length} message(s)`,
      confirmLabel: "Archive",
    });
    if (!confirmed) {
      ok({ archived: 0, method: "batch", reason: "User did not confirm" });
      return;
    }
  }

  await batchArchive(messageIds, account);
  ok({ archived: messageIds.length, method: "batch" });
}

/** Path 4: --message-id — single message archive (no confirmation). */
async function archiveSingleMessage(
  messageId: string,
  account?: string,
): Promise<void> {
  const resp = await gmailPost(
    `/messages/${messageId}/modify`,
    { removeLabelIds: ["INBOX"] },
    account,
  );

  if (!resp.ok) {
    printError(
      `Failed to archive message (status ${resp.status}): ${JSON.stringify(resp.data)}`,
    );
  }

  ok({ archived: 1, method: "single" });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  const query = optionalArg(args, "query");
  const cacheKey = optionalArg(args, "cache-key");
  const senderEmailsRaw = optionalArg(args, "sender-emails");
  const messageIdsRaw = optionalArg(args, "message-ids");
  const messageId = optionalArg(args, "message-id");

  // Priority: --query > --cache-key > --message-ids > --message-id
  if (query) {
    await archiveByQuery(query, account, skipConfirm);
  } else if (cacheKey && senderEmailsRaw) {
    const senderEmails = parseCsv(senderEmailsRaw);
    await archiveByCacheKey(cacheKey, senderEmails, account, skipConfirm);
  } else if (messageIdsRaw) {
    const messageIds = parseCsv(messageIdsRaw);
    await archiveByMessageIds(messageIds, account, skipConfirm);
  } else if (messageId) {
    await archiveSingleMessage(messageId, account);
  } else {
    printError(
      "Provide --query, --cache-key + --sender-emails, --message-ids, or --message-id.",
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
  });
}
