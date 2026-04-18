#!/usr/bin/env bun

/**
 * Outlook email management script.
 * Subcommands: categories, follow-up, attachments, rules, vacation, unsubscribe
 */

import { request as httpsRequest, type IncomingMessage } from "node:https";

import {
  parseArgs,
  printError,
  ok,
  requireArg,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import {
  graphGet,
  graphPatch,
  graphPost,
  graphDelete,
} from "./lib/graph-client.js";

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

interface OutlookCategory {
  displayName: string;
  color: string;
}

interface CategoriesListResponse {
  value: OutlookCategory[];
}

interface MessageWithCategories {
  categories: string[];
}

async function handleCategories(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "list": {
      const res = await graphGet<CategoriesListResponse>(
        "/v1.0/me/outlook/masterCategories",
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to list categories (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "add": {
      const messageId = requireArg(args, "message-id");
      const categoriesStr = requireArg(args, "categories");
      const newCategories = parseCsv(categoriesStr);

      const msgRes = await graphGet<MessageWithCategories>(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { $select: "categories" },
        account,
      );
      if (!msgRes.ok) {
        printError(`Failed to get message (HTTP ${msgRes.status})`);
      }

      const existing = msgRes.data.categories ?? [];
      const merged = [...new Set([...existing, ...newCategories])];

      const patchRes = await graphPatch(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { categories: merged },
        account,
      );
      if (!patchRes.ok) {
        printError(`Failed to update categories (HTTP ${patchRes.status})`);
      }
      ok({ categories: merged });
      break;
    }
    case "remove": {
      const messageId = requireArg(args, "message-id");
      const categoriesStr = requireArg(args, "categories");
      const toRemove = new Set(parseCsv(categoriesStr));

      const msgRes = await graphGet<MessageWithCategories>(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { $select: "categories" },
        account,
      );
      if (!msgRes.ok) {
        printError(`Failed to get message (HTTP ${msgRes.status})`);
      }

      const remaining = (msgRes.data.categories ?? []).filter(
        (c) => !toRemove.has(c),
      );

      const patchRes = await graphPatch(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { categories: remaining },
        account,
      );
      if (!patchRes.ok) {
        printError(`Failed to update categories (HTTP ${patchRes.status})`);
      }
      ok({ categories: remaining });
      break;
    }
    default:
      printError(
        `Unknown categories action: ${action}. Expected: add, remove, list`,
      );
  }
}

// ---------------------------------------------------------------------------
// follow-up
// ---------------------------------------------------------------------------

interface FlaggedMessage {
  subject: string;
  from: unknown;
  receivedDateTime: string;
  flag: { flagStatus: string };
}

interface FlaggedMessagesResponse {
  value: FlaggedMessage[];
}

async function handleFollowUp(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "track": {
      const messageId = requireArg(args, "message-id");
      const res = await graphPatch(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { flag: { flagStatus: "flagged" } },
        account,
      );
      if (!res.ok) {
        printError(`Failed to flag message (HTTP ${res.status})`);
      }
      ok({ flagStatus: "flagged" });
      break;
    }
    case "complete": {
      const messageId = requireArg(args, "message-id");
      const res = await graphPatch(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { flag: { flagStatus: "complete" } },
        account,
      );
      if (!res.ok) {
        printError(`Failed to complete flag (HTTP ${res.status})`);
      }
      ok({ flagStatus: "complete" });
      break;
    }
    case "untrack": {
      const messageId = requireArg(args, "message-id");
      const res = await graphPatch(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
        { flag: { flagStatus: "notFlagged" } },
        account,
      );
      if (!res.ok) {
        printError(`Failed to unflag message (HTTP ${res.status})`);
      }
      ok({ flagStatus: "notFlagged" });
      break;
    }
    case "list": {
      const res = await graphGet<FlaggedMessagesResponse>(
        "/v1.0/me/messages",
        {
          $filter: "flag/flagStatus eq 'flagged'",
          $top: "50",
          $select: "subject,from,receivedDateTime,flag",
        },
        account,
      );
      if (!res.ok) {
        printError(`Failed to list flagged messages (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    default:
      printError(
        `Unknown follow-up action: ${action}. Expected: track, complete, untrack, list`,
      );
  }
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string;
}

interface AttachmentsListResponse {
  value: Attachment[];
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

async function handleAttachments(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");

  switch (action) {
    case "list": {
      const res = await graphGet<AttachmentsListResponse>(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`,
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to list attachments (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "download": {
      const attachmentId = requireArg(args, "attachment-id");
      const res = await graphGet<Attachment>(
        `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to get attachment (HTTP ${res.status})`);
      }

      const attachment = res.data;
      if (!attachment.contentBytes) {
        printError("Attachment has no content bytes");
      }

      const filename = sanitizeFilename(attachment.name || "attachment");
      const bytes = Buffer.from(attachment.contentBytes!, "base64");
      await Bun.write(filename, bytes);
      ok({ filename, size: bytes.length });
      break;
    }
    default:
      printError(
        `Unknown attachments action: ${action}. Expected: list, download`,
      );
  }
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

interface MessageRule {
  id: string;
  displayName: string;
  isEnabled: boolean;
  conditions: unknown;
  actions: unknown;
}

interface RulesListResponse {
  value: MessageRule[];
}

async function handleRules(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "list": {
      const res = await graphGet<RulesListResponse>(
        "/v1.0/me/mailFolders/inbox/messageRules",
        undefined,
        account,
      );
      if (!res.ok) {
        printError(`Failed to list rules (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "create": {
      const name = requireArg(args, "name");
      const conditionsStr = requireArg(args, "conditions");
      const actionsStr = requireArg(args, "actions");

      let conditions: unknown;
      let actions: unknown;
      try {
        conditions = JSON.parse(conditionsStr);
      } catch {
        printError("Failed to parse --conditions JSON");
      }
      try {
        actions = JSON.parse(actionsStr);
      } catch {
        printError("Failed to parse --actions JSON");
      }

      const ruleBody = {
        displayName: name,
        isEnabled: true,
        conditions,
        actions,
      };

      const res = await graphPost<MessageRule>(
        "/v1.0/me/mailFolders/inbox/messageRules",
        ruleBody,
        account,
      );
      if (!res.ok) {
        printError(`Failed to create rule (HTTP ${res.status})`);
      }
      ok(res.data);
      break;
    }
    case "delete": {
      const ruleId = requireArg(args, "rule-id");
      const res = await graphDelete(
        `/v1.0/me/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`,
        account,
      );
      if (!res.ok) {
        printError(`Failed to delete rule (HTTP ${res.status})`);
      }
      ok({ deleted: true, ruleId });
      break;
    }
    default:
      printError(
        `Unknown rules action: ${action}. Expected: list, create, delete`,
      );
  }
}

// ---------------------------------------------------------------------------
// vacation
// ---------------------------------------------------------------------------

interface AutomaticRepliesSetting {
  status: string;
  externalAudience: string;
  internalReplyMessage: string;
  externalReplyMessage: string;
  scheduledStartDateTime?: { dateTime: string; timeZone: string };
  scheduledEndDateTime?: { dateTime: string; timeZone: string };
}

async function handleVacation(
  args: Record<string, string | boolean>,
): Promise<void> {
  const action = requireArg(args, "action");
  const account = optionalArg(args, "account");

  switch (action) {
    case "get": {
      const res = await graphGet<AutomaticRepliesSetting>(
        "/v1.0/me/mailboxSettings/automaticRepliesSetting",
        undefined,
        account,
      );
      if (!res.ok) {
        printError(
          `Failed to get vacation settings (HTTP ${res.status})`,
        );
      }
      ok(res.data);
      break;
    }
    case "enable": {
      const internalMessage = requireArg(args, "internal-message");
      const externalMessage = optionalArg(args, "external-message");
      const externalAudience =
        optionalArg(args, "external-audience") ?? "all";
      const start = optionalArg(args, "start");
      const end = optionalArg(args, "end");
      const timezone = optionalArg(args, "timezone") ?? "UTC";

      const setting: Record<string, unknown> = {
        status: start && end ? "scheduled" : "alwaysEnabled",
        internalReplyMessage: internalMessage,
        externalReplyMessage: externalMessage ?? internalMessage,
        externalAudience,
      };

      if (start && end) {
        setting.scheduledStartDateTime = {
          dateTime: start,
          timeZone: timezone,
        };
        setting.scheduledEndDateTime = {
          dateTime: end,
          timeZone: timezone,
        };
      }

      const res = await graphPatch(
        "/v1.0/me/mailboxSettings",
        { automaticRepliesSetting: setting },
        account,
      );
      if (!res.ok) {
        printError(
          `Failed to enable vacation replies (HTTP ${res.status})`,
        );
      }
      ok({ enabled: true, setting });
      break;
    }
    case "disable": {
      const res = await graphPatch(
        "/v1.0/me/mailboxSettings",
        { automaticRepliesSetting: { status: "disabled" } },
        account,
      );
      if (!res.ok) {
        printError(
          `Failed to disable vacation replies (HTTP ${res.status})`,
        );
      }
      ok({ enabled: false });
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

interface InternetMessageHeader {
  name: string;
  value: string;
}

interface MessageWithHeaders {
  internetMessageHeaders: InternetMessageHeader[];
}

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
function parseListUnsubscribe(
  headerValue: string,
): { https: string[]; mailto: string[] } {
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
      mailto.push(url.slice(7)); // strip "mailto:"
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
        resolve({ ok: status >= 200 && status < 300, status });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function handleUnsubscribe(
  args: Record<string, string | boolean>,
): Promise<void> {
  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");

  // Fetch message headers
  const res = await graphGet<MessageWithHeaders>(
    `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    { $select: "internetMessageHeaders" },
    account,
  );
  if (!res.ok) {
    printError(`Failed to get message headers (HTTP ${res.status})`);
  }

  const headers = res.data.internetMessageHeaders ?? [];
  const unsubHeader = headers.find(
    (h) => h.name.toLowerCase() === "list-unsubscribe",
  );

  if (!unsubHeader) {
    printError("No List-Unsubscribe header found on this message");
  }

  const parsed = parseListUnsubscribe(unsubHeader!.value);

  // Import DNS resolver once for all HTTPS URL checks
  const { resolve: dnsResolve } = await import("dns/promises");

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
      // to prevent TOCTOU DNS rebinding attacks (where a second DNS lookup
      // by fetch() could resolve to a different, malicious IP).
      const resolvedIp = addresses[0];
      const port = urlObj.port ? Number(urlObj.port) : 443;
      const pathAndSearch = urlObj.pathname + urlObj.search;

      // Try POST first (RFC 8058 List-Unsubscribe-Post)
      const postResult = await pinnedHttpsRequest(
        resolvedIp,
        port,
        pathAndSearch,
        hostname,
        "POST",
        { Host: hostname, "List-Unsubscribe": "One-Click" },
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

      // Try GET if POST didn't work
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

      // Both failed — continue to next URL
      continue;
    } catch {
      // If this URL fails, try the next one
      continue;
    }
  }

  // Fall back to mailto
  if (parsed.mailto.length > 0) {
    ok({
      method: "mailto",
      address: parsed.mailto[0],
      message:
        "Send an unsubscribe email to this address to complete unsubscription",
    });
    return;
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
    case "categories":
      await handleCategories(args);
      break;
    case "follow-up":
      await handleFollowUp(args);
      break;
    case "attachments":
      await handleAttachments(args);
      break;
    case "rules":
      await handleRules(args);
      break;
    case "vacation":
      await handleVacation(args);
      break;
    case "unsubscribe":
      await handleUnsubscribe(args);
      break;
    default:
      printError(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Expected: categories, follow-up, attachments, rules, vacation, unsubscribe`,
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
