/**
 * Gmail normalizer.
 *
 * Gmail's poll returns a snippet, not a body, so `normalize` leaves
 * `content.full` null and the body costs a second `messages.get`. That is what
 * `fetchFull` is for, and why the judgment layer tiers on the preview first.
 */

import {
  batchGetMessages,
  GMAIL_REQUIRED_SCOPES,
} from "../../../messaging/providers/gmail/client.js";
import {
  extractPlainTextBody,
  parseFromHeader,
} from "../../../messaging/providers/gmail/message-fields.js";
import { resolveOAuthConnection } from "../../../oauth/connection-resolver.js";
import { getLogger } from "../../../util/logger.js";
import type { WatcherItem } from "../../../watcher/provider-types.js";
import { attachContactId } from "./resolve-sender.js";
import type {
  NormalizedNotification,
  NotificationCategory,
  NotificationNormalizer,
} from "./types.js";

const log = getLogger("notification-filter:gmail");

/**
 * Credential service a Gmail record falls back to when it carries none of its
 * own, matching `gmailProvider.requiredCredentialService`.
 */
const DEFAULT_GMAIL_CREDENTIAL_SERVICE = "google";

/**
 * Gmail labels that mark bulk mail regardless of who it is addressed to.
 *
 * `CATEGORY_PROMOTIONS` is Gmail's own marketing bucket, so reading it as bulk
 * is mechanical. `CATEGORY_UPDATES` deliberately stays off this list: it holds
 * receipts, shipping notices, account changes and security alerts alongside
 * genuine bulk mail, so mapping it here would tier a fraud alert down as bulk
 * on a label alone. Those messages take the ordinary determination below and
 * the judgment layer weighs their content, which is where a call that broad
 * belongs.
 */
const BROADCAST_LABEL_IDS = ["CATEGORY_PROMOTIONS"];

/** Header keys the watcher payload hoists to top-level scalars. */
const HOISTED_HEADER_KEYS = ["from", "subject", "date", "to", "cc"];

/**
 * Case-insensitive header reader over a Gmail watcher payload. The payload
 * carries a few headers as top-level scalars and may carry the rest under a
 * `headers` record; both forms answer the same lookup.
 */
function headerReader(
  payload: Record<string, unknown>,
): (name: string) => string | null {
  const headers = new Map<string, string>();
  const raw = payload.headers;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        headers.set(key.toLowerCase(), value);
      }
    }
  }
  for (const key of HOISTED_HEADER_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0 && !headers.has(key)) {
      headers.set(key, value);
    }
  }
  return (name: string) => headers.get(name.toLowerCase()) ?? null;
}

/**
 * The entries of an RFC 5322 address list.
 *
 * A comma separates entries only outside a quoted display name and outside an
 * angle-bracketed address, so `"User, Example" <owner@example.com>` is the one
 * address it is written as rather than two.
 */
function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let bracketed = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && (char === "<" || char === ">")) {
      bracketed = char === "<";
      current += char;
      continue;
    }
    if (char === "," && !quoted && !bracketed) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current);

  return entries;
}

/**
 * The addresses in an RFC 5322 address list, lowercased. An entry yields its
 * angle-bracketed address when it has one and the entry itself otherwise,
 * which is the bare-address form.
 */
function parseAddressList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return splitAddressList(value)
    .map((entry) => {
      const bracketed = entry.match(/<([^>]+)>/);
      return (bracketed?.[1] ?? entry).trim().toLowerCase();
    })
    .filter((entry) => entry.length > 0);
}

function readLabelIds(payload: Record<string, unknown>): string[] {
  const labelIds = payload.labelIds;
  if (!Array.isArray(labelIds)) {
    return [];
  }
  return labelIds.filter((id): id is string => typeof id === "string");
}

/**
 * Categorize from headers the watcher already carries, with no network I/O on
 * a path that runs for every polled message.
 *
 * Bulk mail wins over everything else, and only on the two mechanical signals
 * that say so outright: the RFC 2369 `List-Unsubscribe` header, and Gmail's
 * own marketing label. `dm` then means the mailbox is the sole
 * address in `To`: the message was written to the user and to nobody else,
 * whoever else was copied on it. That is a comparison against the authenticated
 * mailbox address, not an inference from how many recipients a message names,
 * which is why a one-address list alias does not read as a direct message and
 * a direct message with a colleague in `Cc` still does. Without that address
 * there is nothing to compare, so the message falls through rather than being
 * guessed at.
 */
function categorize(
  header: (name: string) => string | null,
  labelIds: string[],
  mailboxAddress: string | null,
): NotificationCategory {
  if (
    header("List-Unsubscribe") ||
    labelIds.some((id) => BROADCAST_LABEL_IDS.includes(id))
  ) {
    return "broadcast";
  }

  if (mailboxAddress) {
    const to = parseAddressList(header("To"));
    if (to.length === 1 && to[0] === mailboxAddress) {
      return "dm";
    }
  }

  return header("In-Reply-To") ? "reply" : "fyi";
}

/** The credential service the watcher polled this message with. */
function readCredentialService(
  payload: Record<string, unknown>,
): string | null {
  const value = payload.credentialService;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The authenticated mailbox address the watcher stamped on the payload. */
function readMailboxAddress(payload: Record<string, unknown>): string | null {
  const value = payload.mailboxAddress;
  if (typeof value !== "string") {
    return null;
  }
  const [address] = parseAddressList(value);
  return address ?? null;
}

/**
 * The account the poll read this message from, as the connection resolver's
 * `account` option expects it.
 *
 * That option is an account identifier, and the authenticated mailbox address
 * is the one the resolver can match on both paths: it is the account label
 * stored on a BYO connection row and the `account_identifier` the platform
 * lists managed connections by. A connection id would pin only the BYO path,
 * since a managed connection reports the provider key as its id. The value is
 * carried verbatim so it matches a stored label exactly.
 */
function readCredentialAccount(
  payload: Record<string, unknown>,
): string | null {
  const value = payload.mailboxAddress;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const gmailNormalizer: NotificationNormalizer = {
  source: "gmail",

  normalize(item: WatcherItem): NormalizedNotification | null {
    const payload = item.payload;
    const header = headerReader(payload);

    const snippet = typeof payload.snippet === "string" ? payload.snippet : "";
    const preview = (snippet.trim() || header("Subject") || "").trim();
    if (!preview) {
      log.debug(
        { externalId: item.externalId },
        "Dropping Gmail item with no snippet or subject",
      );
      return null;
    }

    const from = header("From");
    const parsedFrom = from ? parseFromHeader(from) : null;
    const threadId =
      typeof payload.threadId === "string" ? payload.threadId : null;

    return {
      source: "gmail",
      externalId: item.externalId,
      credentialService: readCredentialService(payload),
      credentialAccount: readCredentialAccount(payload),
      sender: parsedFrom
        ? attachContactId(
            {
              rawId: parsedFrom.address,
              displayName: parsedFrom.displayName,
            },
            "email",
            { address: parsedFrom.address },
          )
        : null,
      container: threadId
        ? { type: "inbox", id: threadId, displayName: null }
        : null,
      content: {
        preview,
        full: null,
        category: categorize(
          header,
          readLabelIds(payload),
          readMailboxAddress(payload),
        ),
      },
      meta: {
        timestamp: item.timestamp,
        nativePriority: null,
        threadReplyCount: null,
        hasAttachments: null,
      },
    };
  },

  async fetchFull(item: NormalizedNotification): Promise<string | null> {
    try {
      // The same connection the poll read the message over. A workspace can
      // hold more than one Gmail credential, so the default service would be a
      // different account; and several accounts can sit behind one service, so
      // the service alone resolves to whichever connection is newest at this
      // moment. The mailbox the poll authenticated as pins both. A message ID
      // is scoped to its mailbox, so resolving any other one reads nothing.
      const connection = await resolveOAuthConnection(
        item.credentialService ?? DEFAULT_GMAIL_CREDENTIAL_SERVICE,
        {
          requiredScopes: GMAIL_REQUIRED_SCOPES,
          account: item.credentialAccount ?? undefined,
        },
      );
      const [message] = await batchGetMessages(
        connection,
        [item.externalId],
        "full",
      );
      if (!message) {
        return null;
      }
      return extractPlainTextBody(message) || null;
    } catch (err) {
      log.debug({ err, externalId: item.externalId }, "Gmail fetchFull failed");
      return null;
    }
  },
};
