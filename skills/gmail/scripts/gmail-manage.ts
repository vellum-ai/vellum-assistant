#!/usr/bin/env bun

/**
 * Gmail email management script.
 * Subcommands: label, follow-up, attachments, filters, vacation, unsubscribe
 */

import { request as httpsRequest, type IncomingMessage } from "node:https";
import { resolve as dnsResolve } from "dns/promises";
import { basename, resolve as resolvePath } from "node:path";

import {
  parseArgs,
  printError,
  ok,
  requireArg,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import {
  gmailGet,
  gmailPost,
  gmailPut,
  gmailDelete,
  gmailRequest,
  batchFetchMessages,
  type GmailMessage,
  type GmailMessagePart,
} from "./lib/gmail-client.js";

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------

async function handleLabel(
  args: Record<string, string | boolean>,
): Promise<void> {
  const account = optionalArg(args, "account");
  const messageId = optionalArg(args, "message-id");
  const messageIdsStr = optionalArg(args, "message-ids");
  const addLabelsStr = optionalArg(args, "add-labels");
  const removeLabelsStr = optionalArg(args, "remove-labels");

  const addLabelIds = addLabelsStr ? parseCsv(addLabelsStr) : undefined;
  const removeLabelIds = removeLabelsStr
    ? parseCsv(removeLabelsStr)
    : undefined;

  if (messageIdsStr) {
    const ids = parseCsv(messageIdsStr);
    const res = await gmailPost(
      "/messages/batchModify",
      {
        ids,
        addLabelIds: addLabelIds ?? [],
        removeLabelIds: removeLabelIds ?? [],
      },
      account,
    );
    if (!res.ok) {
      printError(`Failed to batch modify labels (HTTP ${res.status})`);
    }
    ok({ updated: true });
    return;
  }

  if (messageId) {
    const res = await gmailPost(
      `/messages/${messageId}/modify`,
      {
        addLabelIds: addLabelIds ?? [],
        removeLabelIds: removeLabelIds ?? [],
      },
      account,
    );
    if (!res.ok) {
      printError(`Failed to modify labels (HTTP ${res.status})`);
    }
    ok({ updated: true });
    return;
  }

  printError("Provide --message-id or --message-ids.");
}

// ---------------------------------------------------------------------------
// follow-up
// ---------------------------------------------------------------------------

interface GmailLabel {
  id: string;
  name: string;
}

interface LabelsListResponse {
  labels: GmailLabel[];
}

const FOLLOW_UP_LABEL_NAME = "Follow-up";

async function getOrCreateFollowUpLabel(account?: string): Promise<string> {
  const res = await gmailGet<LabelsListResponse>("/labels", undefined, account);
  if (!res.ok) {
    printError(`Failed to list labels (HTTP ${res.status})`);
  }

  const existing = (res.data.labels ?? []).find(
    (l) => l.name === FOLLOW_UP_LABEL_NAME,
  );
  if (existing) return existing.id;

  const createRes = await gmailPost<GmailLabel>(
    "/labels",
    { name: FOLLOW_UP_LABEL_NAME },
    account,
  );
  if (!createRes.ok) {
    printError(`Failed to create Follow-up label (HTTP ${createRes.status})`);
  }
  return createRes.data.id;
}

async function handleFollowUp(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "track": {
      const messageId = requireArg(args, "message-id");
      const labelId = await getOrCreateFollowUpLabel(account);
      const res = await gmailPost(
        `/messages/${messageId}/modify`,
        { addLabelIds: [labelId] },
        account,
      );
      if (!res.ok) {
        printError(`Failed to track message (HTTP ${res.status})`);
      }
      ok({ tracked: true });
      break;
    }
    case "untrack": {
      const messageId = requireArg(args, "message-id");
      const labelId = await getOrCreateFollowUpLabel(account);
      const res = await gmailPost(
        `/messages/${messageId}/modify`,
        { removeLabelIds: [labelId] },
        account,
      );
      if (!res.ok) {
        printError(`Failed to untrack message (HTTP ${res.status})`);
      }
      ok({ untracked: true });
      break;
    }
    case "list": {
      const labelId = await getOrCreateFollowUpLabel(account);
      const listRes = await gmailGet<{ messages?: Array<{ id: string }> }>(
        "/messages",
        { labelIds: labelId, maxResults: "50" },
        account,
      );
      if (!listRes.ok) {
        printError(
          `Failed to list follow-up messages (HTTP ${listRes.status})`,
        );
      }

      const messageIds = (listRes.data.messages ?? []).map((m) => m.id);
      if (messageIds.length === 0) {
        ok({ messages: [] });
        break;
      }

      const messages = await batchFetchMessages(
        messageIds,
        "metadata",
        ["From", "Subject", "Date"],
        account,
        undefined,
        "id,threadId,payload/headers",
      );
      const items = messages.map((m) => {
        const headers = m.payload?.headers ?? [];
        const from =
          headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
        const subject =
          headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
        const date =
          headers.find((h) => h.name.toLowerCase() === "date")?.value ?? "";
        return { id: m.id, threadId: m.threadId, from, subject, date };
      });
      ok({ messages: items });
      break;
    }
    default:
      printError(
        `Unknown follow-up action: ${action}. Expected: track, list, untrack`,
      );
  }
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** Recursively walk the MIME parts tree to find attachments. */
function collectAttachments(
  parts: GmailMessagePart[] | undefined,
): AttachmentInfo[] {
  if (!parts) return [];
  const result: AttachmentInfo[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      result.push({
        partId: part.partId ?? "",
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      result.push(...collectAttachments(part.parts));
    }
  }
  return result;
}

async function handleAttachments(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");

  switch (action) {
    case "list": {
      const res = await gmailGet<GmailMessage>(
        `/messages/${messageId}`,
        { format: "full" },
        account,
      );
      if (!res.ok) {
        printError(`Failed to get message (HTTP ${res.status})`);
      }
      const attachments = collectAttachments(res.data.payload?.parts);
      ok({
        attachments: attachments.map((a) => ({
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      });
      break;
    }
    case "download": {
      const attachmentId = requireArg(args, "attachment-id");
      const filename = requireArg(args, "filename");

      const res = await gmailGet<{ data: string; size: number }>(
        `/messages/${messageId}/attachments/${attachmentId}`,
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to get attachment (HTTP ${res.status})`);
      }

      // Gmail returns base64url; convert to standard base64 then to Buffer
      const base64 = res.data.data.replace(/-/g, "+").replace(/_/g, "/");
      const buffer = Buffer.from(base64, "base64");

      // Sanitize filename: strip path separators to prevent traversal attacks
      const safeName = basename(filename).replace(/\.\./g, "_");
      const outputDir = process.cwd();
      const outputPath = resolvePath(outputDir, safeName);
      if (!outputPath.startsWith(outputDir)) {
        printError("Invalid filename: path traversal detected.");
      }

      await Bun.write(outputPath, buffer);
      ok({ path: outputPath, name: safeName, size: buffer.length });
      break;
    }
    default:
      printError(
        `Unknown attachments action: ${action}. Expected: list, download`,
      );
  }
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  hasAttachment?: boolean;
}

interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

interface FiltersListResponse {
  filter?: GmailFilter[];
}

async function handleFilters(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "list": {
      const res = await gmailGet<FiltersListResponse>(
        "/settings/filters",
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to list filters (HTTP ${res.status})`);
      }
      ok(res.data.filter ?? []);
      break;
    }
    case "create": {
      const criteria: GmailFilterCriteria = {};
      const from = optionalArg(args, "from");
      const to = optionalArg(args, "to");
      const subject = optionalArg(args, "subject");
      const query = optionalArg(args, "query");
      const hasAttachment = args["has-attachment"];

      if (from) criteria.from = from;
      if (to) criteria.to = to;
      if (subject) criteria.subject = subject;
      if (query) criteria.query = query;
      if (hasAttachment === true) criteria.hasAttachment = true;

      if (Object.keys(criteria).length === 0) {
        printError(
          "At least one filter criteria is required (--from, --to, --subject, --query, or --has-attachment).",
        );
      }

      const filterAction: GmailFilterAction = {};
      const addLabelsStr = optionalArg(args, "add-labels");
      const removeLabelsStr = optionalArg(args, "remove-labels");
      const forward = optionalArg(args, "forward");

      if (addLabelsStr) filterAction.addLabelIds = parseCsv(addLabelsStr);
      if (removeLabelsStr)
        filterAction.removeLabelIds = parseCsv(removeLabelsStr);
      if (forward) filterAction.forward = forward;

      const res = await gmailPost<GmailFilter>(
        "/settings/filters",
        { criteria, action: filterAction },
        account,
      );
      if (!res.ok) {
        printError(`Failed to create filter (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "delete": {
      const filterId = requireArg(args, "filter-id");
      const res = await gmailDelete(`/settings/filters/${filterId}`, account);
      if (!res.ok) {
        printError(`Failed to delete filter (HTTP ${res.status})`);
      }
      ok({ deleted: true, filterId });
      break;
    }
    default:
      printError(
        `Unknown filters action: ${action}. Expected: list, create, delete`,
      );
  }
}

// ---------------------------------------------------------------------------
// vacation
// ---------------------------------------------------------------------------

interface GmailVacationSettings {
  enableAutoReply: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  startTime?: string;
  endTime?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
}

async function handleVacation(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "get": {
      const res = await gmailGet<GmailVacationSettings>(
        "/settings/vacation",
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to get vacation settings (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "enable": {
      const message = requireArg(args, "message");
      const subject = optionalArg(args, "subject");
      const startTime = optionalArg(args, "start-time");
      const endTime = optionalArg(args, "end-time");
      const restrictToContacts = args["restrict-to-contacts"] === true;
      const restrictToDomain = args["restrict-to-domain"] === true;

      const settings: GmailVacationSettings = {
        enableAutoReply: true,
        responseBodyPlainText: message,
        restrictToContacts,
        restrictToDomain,
      };
      if (subject) settings.responseSubject = subject;
      if (startTime) settings.startTime = startTime;
      if (endTime) settings.endTime = endTime;

      const res = await gmailPut<GmailVacationSettings>(
        "/settings/vacation",
        settings,
        account,
      );
      if (!res.ok) {
        printError(`Failed to enable vacation responder (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "disable": {
      const res = await gmailPut<GmailVacationSettings>(
        "/settings/vacation",
        { enableAutoReply: false },
        account,
      );
      if (!res.ok) {
        printError(`Failed to disable vacation responder (HTTP ${res.status})`);
      }
      ok({ disabled: true });
      break;
    }
    default:
      printError(
        `Unknown vacation action: ${action}. Expected: get, enable, disable`,
      );
  }
}

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is private, loopback, or otherwise reserved
 * (DNS rebinding / SSRF protection).
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;

  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(ip)) return true;

  // IPv6 unique-local (fc00::/7 — fc00::/8 + fd00::/8)
  if (/^f[cd]/i.test(ip)) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    return isPrivateIp(v4Mapped[1]);
  }

  // IPv4
  const parts = ip.split(".");
  if (parts.length === 4) {
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);

    // 0.x.x.x ("This" network, RFC 1122)
    if (a === 0) return true;
    // 10.x.x.x (private, RFC 1918)
    if (a === 10) return true;
    // 100.64-127.x.x (CGNAT, RFC 6598)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.x.x.x (loopback, RFC 1122)
    if (a === 127) return true;
    // 169.254.x.x (link-local, RFC 3927 — includes cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0 - 172.31.255.255 (private, RFC 1918)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.x.x (private, RFC 1918)
    if (a === 192 && b === 168) return true;
    // 198.18.x.x - 198.19.x.x (benchmarking, RFC 2544)
    if (a === 198 && b >= 18 && b <= 19) return true;
    // 224+ (multicast 224-239 and reserved 240-255, RFC 5771 / RFC 1112)
    if (a >= 224) return true;
  }

  return false;
}

/**
 * Parse List-Unsubscribe header into HTTPS URLs and mailto addresses.
 */
function parseListUnsubscribe(headerValue: string): {
  https: string[];
  mailto: string[];
} {
  const https: string[] = [];
  const mailto: string[] = [];

  // Header format: <url1>, <url2>, ...
  const matches = headerValue.match(/<[^>]+>/g);
  if (!matches) return { https, mailto };

  for (const match of matches) {
    const url = match.slice(1, -1).trim();
    if (url.startsWith("https://")) {
      https.push(url);
    } else if (url.startsWith("mailto:")) {
      // Strip "mailto:" prefix and any query parameters (?subject=..., ?body=...)
      mailto.push(url.slice(7).split("?")[0]);
    }
  }

  return { https, mailto };
}

/**
 * Make an HTTPS request pinned to a specific resolved IP address.
 * This prevents TOCTOU DNS rebinding attacks by connecting directly to the
 * pre-validated IP while setting the Host header and SNI servername to the
 * original hostname for correct TLS and virtual hosting.
 */
function pinnedHttpsRequest(
  resolvedIp: string,
  port: number,
  path: string,
  hostname: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: resolvedIp,
        port,
        path,
        method,
        headers,
        servername: hostname, // SNI for TLS
      },
      (res: IncomingMessage) => {
        // Consume the response body to free resources
        res.resume();
        const status = res.statusCode ?? 0;
        // Accept 2xx and 3xx (redirects are common for unsubscribe endpoints)
        resolve({ ok: status >= 200 && status < 400, status });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const confirmArgs = [
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

  const proc = Bun.spawn(confirmArgs, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

async function handleUnsubscribe(
  args: Record<string, string | boolean>,
): Promise<void> {
  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  // Fetch message metadata with unsubscribe headers and sender info.
  // metadataHeaders must be sent as repeated query params, not comma-separated.
  const unsubMetadataHeaders = [
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "From",
  ];
  const res = await gmailRequest<GmailMessage>({
    method: "GET",
    path: `/messages/${messageId}`,
    query: { format: "metadata" },
    account,
    pathSuffix: unsubMetadataHeaders
      .map((h) => `&metadataHeaders=${encodeURIComponent(h)}`)
      .join(""),
  });
  if (!res.ok) {
    printError(`Failed to get message headers (HTTP ${res.status})`);
  }

  const headers = res.data.payload?.headers ?? [];

  // Extract sender for the confirmation prompt
  const fromHeader = headers.find(
    (h) => h.name.toLowerCase() === "from",
  )?.value;
  const senderDisplay = fromHeader ?? "(unknown sender)";

  // Gate on user confirmation unless explicitly skipped
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Unsubscribe",
      message: `Unsubscribe from mailing list: ${senderDisplay}\nThis action cannot be undone.`,
      confirmLabel: "Unsubscribe",
    });

    if (!confirmed) {
      ok({ unsubscribed: false, reason: "User did not confirm" });
      return;
    }
  }

  const unsubHeader = headers.find(
    (h) => h.name.toLowerCase() === "list-unsubscribe",
  )?.value;

  if (!unsubHeader) {
    printError("No List-Unsubscribe header found on this message");
  }

  // RFC 8058: only use POST when List-Unsubscribe-Post header is present
  const postHeader = headers.find(
    (h) => h.name.toLowerCase() === "list-unsubscribe-post",
  );

  const parsed = parseListUnsubscribe(unsubHeader!);

  // Prefer HTTPS unsubscribe
  for (const url of parsed.https) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      // DNS rebinding protection: resolve and check for private IPs
      let addresses: string[];
      try {
        addresses = await dnsResolve(hostname);
      } catch {
        // If DNS resolution fails, skip this URL
        continue;
      }

      const hasPrivate = addresses.some(isPrivateIp);
      if (hasPrivate) {
        continue; // Skip URLs that resolve to private IPs
      }

      // Pin DNS: connect directly to resolved IP with proper Host/SNI headers
      const resolvedIp = addresses[0];
      const port = urlObj.port ? Number(urlObj.port) : 443;
      const pathAndSearch = urlObj.pathname + urlObj.search;

      // RFC 8058: only use POST when List-Unsubscribe-Post header is present
      if (postHeader) {
        const postBody = postHeader.value.trim();
        const postResult = await pinnedHttpsRequest(
          resolvedIp,
          port,
          pathAndSearch,
          hostname,
          "POST",
          {
            Host: hostname,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          postBody,
        );
        if (postResult.ok) {
          ok({
            method: "https",
            url,
            status: postResult.status,
            success: true,
          });
          return;
        }
      }

      // Use GET (either as fallback from POST failure, or when no
      // List-Unsubscribe-Post header is present)
      const getResult = await pinnedHttpsRequest(
        resolvedIp,
        port,
        pathAndSearch,
        hostname,
        "GET",
        { Host: hostname },
      );
      if (getResult.ok) {
        ok({
          method: "https",
          url,
          status: getResult.status,
          success: true,
        });
        return;
      }

      // GET failed — continue to next URL
      continue;
    } catch {
      // If this URL fails, try the next one
      continue;
    }
  }

  // Fall back to mailto: send unsubscribe email via Gmail API
  if (parsed.mailto.length > 0) {
    const mailtoAddr = parsed.mailto[0];

    // Build raw MIME message for the unsubscribe email
    const rawMime = [
      `To: ${mailtoAddr}`,
      "Subject: Unsubscribe",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Unsubscribe",
    ].join("\r\n");

    // base64url encode the MIME message
    const raw = Buffer.from(rawMime, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendRes = await gmailPost("/messages/send", { raw }, account);

    if (sendRes.ok) {
      ok({
        method: "mailto",
        address: mailtoAddr,
        success: true,
      });
      return;
    }

    printError(
      `Failed to send unsubscribe email to ${mailtoAddr} (HTTP ${sendRes.status})`,
    );
    throw new Error("unreachable");
  }

  printError(
    "No usable unsubscribe link found (all HTTPS links failed or were blocked, no mailto alternative)",
  );
}

// ---------------------------------------------------------------------------
// main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  switch (subcommand) {
    case "label":
      await handleLabel(args);
      break;
    case "follow-up":
      await handleFollowUp(args);
      break;
    case "attachments":
      await handleAttachments(args);
      break;
    case "filters":
      await handleFilters(args);
      break;
    case "vacation":
      await handleVacation(args);
      break;
    case "unsubscribe":
      await handleUnsubscribe(args);
      break;
    default:
      printError(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Expected: label, follow-up, attachments, filters, vacation, unsubscribe`,
      );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}
