/**
 * Gmail watcher provider — uses the History API for efficient change detection.
 *
 * On first poll, captures the current historyId as the watermark (start from "now").
 * Subsequent polls use history.list with historyTypes=messageAdded to detect new messages.
 * Falls back to listing recent unread messages if the historyId has expired (404).
 */

import {
  batchGetMessages,
  getProfile,
  GMAIL_API_BASE_URL,
  GMAIL_REQUIRED_SCOPES,
  listMessages,
} from "../../messaging/providers/gmail/client.js";
import { extractHeader } from "../../messaging/providers/gmail/message-fields.js";
import type {
  GmailMessage,
  GmailProfile,
} from "../../messaging/providers/gmail/types.js";
import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:gmail");

/** Gmail History API response types */
interface HistoryMessage {
  id: string;
  threadId: string;
}

interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: HistoryMessage }>;
}

interface HistoryListResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

/**
 * Headers requested with `format=metadata`.
 *
 * More than the summary line needs: the notification normalizer categorizes a
 * message from its recipients and from the reply and list headers, and a
 * metadata fetch returns only what is asked for, so a header left out of this
 * list is a categorization that silently degrades to `fyi`.
 */
export const METADATA_HEADERS = [
  "From",
  "Subject",
  "Date",
  "To",
  "Cc",
  "In-Reply-To",
  "List-Unsubscribe",
];

/**
 * The authenticated mailbox address, per credential service.
 *
 * It is a property of the credential rather than of the poll, so it is
 * resolved once and reused. Without it the normalizer cannot tell a message
 * addressed to the user from one addressed to a one-address list alias, and
 * has to fall back rather than guess.
 */
const mailboxAddressByService = new Map<string, string>();

function rememberMailboxAddress(
  credentialService: string,
  profile: GmailProfile,
): void {
  if (profile.emailAddress) {
    mailboxAddressByService.set(credentialService, profile.emailAddress);
  }
}

/**
 * The mailbox address for this credential, from cache when a profile call has
 * already happened this process. A failure is not fatal: categorization
 * degrades, the poll does not.
 */
async function resolveMailboxAddress(
  connection: OAuthConnection,
  credentialService: string,
): Promise<string | null> {
  const cached = mailboxAddressByService.get(credentialService);
  if (cached) {
    return cached;
  }
  try {
    const profile = await getProfile(connection);
    rememberMailboxAddress(credentialService, profile);
    return profile.emailAddress ?? null;
  } catch (err) {
    log.warn({ err }, "Gmail: could not resolve the mailbox address");
    return null;
  }
}

/** Exported for the test that pins the payload the normalizer reads. */
export function messageToItem(
  msg: GmailMessage,
  mailboxAddress: string | null,
  credentialService: string,
): WatcherItem {
  const headers: Record<string, string> = {};
  for (const name of METADATA_HEADERS) {
    const value = extractHeader(msg, name);
    if (value) {
      headers[name] = value;
    }
  }

  const from = headers.From ?? "";
  const subject = headers.Subject ?? "";

  return {
    externalId: msg.id,
    eventType: "new_email",
    summary: `Email from ${from}: ${subject}`,
    payload: {
      id: msg.id,
      threadId: msg.threadId,
      // Kept as top-level scalars alongside the record below: existing readers
      // (`sequence/reply-matcher.ts`, stored rows written before this) index
      // `payload.from` directly.
      from,
      subject,
      date: headers.Date ?? "",
      headers,
      // The normalizer carries this onto its record so a follow-up body fetch
      // resolves the account this poll read, not the default Gmail credential.
      credentialService,
      ...(mailboxAddress ? { mailboxAddress } : {}),
      snippet: msg.snippet ?? "",
      labelIds: msg.labelIds ?? [],
    },
    timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
  };
}

async function fetchHistory(
  connection: OAuthConnection,
  startHistoryId: string,
): Promise<HistoryListResponse> {
  const query: Record<string, string> = {
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "100",
  };

  const resp = await connection.request({
    method: "GET",
    path: "/history",
    baseUrl: GMAIL_API_BASE_URL,
    query,
  });

  if (resp.status === 404) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new HistoryExpiredError(body);
  }

  if (resp.status < 200 || resp.status >= 300) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new Error(`Gmail History API ${resp.status}: ${body}`);
  }

  return resp.body as HistoryListResponse;
}

class HistoryExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryExpiredError";
  }
}

export const gmailProvider: WatcherProvider = {
  id: "gmail",
  displayName: "Gmail",
  requiredCredentialService: "google",
  untrustedContentSource: "email",

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService, {
      requiredScopes: GMAIL_REQUIRED_SCOPES,
    });
    const profile = await getProfile(connection);
    rememberMailboxAddress(credentialService, profile);
    if (!profile.historyId) {
      throw new Error("Gmail profile did not return a historyId");
    }
    return profile.historyId;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService, {
      requiredScopes: GMAIL_REQUIRED_SCOPES,
    });

    if (!watermark) {
      // No watermark — get initial position, return no items
      const profile = await getProfile(connection);
      rememberMailboxAddress(credentialService, profile);
      return { items: [], watermark: profile.historyId ?? "0" };
    }

    try {
      const historyResp = await fetchHistory(connection, watermark);
      const newWatermark = historyResp.historyId ?? watermark;

      if (!historyResp.history || historyResp.history.length === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Collect unique new message IDs
      const messageIds = new Set<string>();
      for (const record of historyResp.history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            messageIds.add(added.message.id);
          }
        }
      }

      if (messageIds.size === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Fetch metadata for new messages
      const messages = await batchGetMessages(
        connection,
        Array.from(messageIds),
        "metadata",
        METADATA_HEADERS,
      );

      // Only include INBOX messages (skip sent, drafts, etc.)
      const inboxMessages = messages.filter((m) =>
        m.labelIds?.includes("INBOX"),
      );

      const mailboxAddress =
        inboxMessages.length > 0
          ? await resolveMailboxAddress(connection, credentialService)
          : null;
      const items = inboxMessages.map((m) =>
        messageToItem(m, mailboxAddress, credentialService),
      );
      log.info(
        { count: items.length, watermark: newWatermark },
        "Gmail: fetched new messages",
      );

      return { items, watermark: newWatermark };
    } catch (err) {
      if (err instanceof HistoryExpiredError) {
        log.warn(
          "Gmail historyId expired, falling back to recent unread messages",
        );
        return fallbackFetch(connection, credentialService);
      }
      throw err;
    }
  },
};

/**
 * Fallback when historyId expires: list recent unread inbox messages.
 */
async function fallbackFetch(
  connection: OAuthConnection,
  credentialService: string,
): Promise<FetchResult> {
  const listResp = await listMessages(
    connection,
    "is:unread newer_than:1d",
    20,
    undefined,
    ["INBOX"],
  );

  if (!listResp.messages || listResp.messages.length === 0) {
    const profile = await getProfile(connection);
    rememberMailboxAddress(credentialService, profile);
    return { items: [], watermark: profile.historyId ?? "0" };
  }

  const messages = await batchGetMessages(
    connection,
    listResp.messages.map((m) => m.id),
    "metadata",
    METADATA_HEADERS,
  );

  // Get fresh historyId for the new watermark. The same call carries the
  // mailbox address, so categorization costs nothing extra on this path.
  const profile = await getProfile(connection);
  rememberMailboxAddress(credentialService, profile);

  const mailboxAddress = profile.emailAddress ?? null;
  const items = messages.map((m) =>
    messageToItem(m, mailboxAddress, credentialService),
  );

  return { items, watermark: profile.historyId ?? "0" };
}
