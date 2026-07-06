import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { Readable } from "node:stream";

import { getConfig } from "../../config/loader.js";
import type {
  WebFetchMetadata,
  WebFetchProviderId,
} from "../../daemon/message-types/web-activity.js";
import { RiskLevel } from "../../permissions/types.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { faviconUrlForDomain } from "../../util/favicon.js";
import { getLogger } from "../../util/logger.js";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  getHttpRetryDelay,
  sleep,
} from "../../util/retry.js";
import { safeStringSlice } from "../../util/unicode.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import { extractDomain } from "./domain-normalize.js";
import {
  buildHostHeader,
  isIPv4,
  isIPv6,
  isPrivateOrLocalHost,
  parseUrl,
  type ResolveHostAddresses,
  resolveHostAddresses,
  resolveRequestAddress,
  sanitizeUrlForOutput,
  sanitizeUrlStringForOutput,
  stripUrlUserinfo,
  unwrapBracketedHostname,
} from "./url-safety.js";

const log = getLogger("web-fetch");

const FIRECRAWL_SCRAPE_API_URL = "https://api.firecrawl.dev/v2/scrape";

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 40_000;
const MAX_DOWNLOAD_BYTES = 2_000_000;
const MAX_REDIRECTS = 10;

const TEXT_LIKE_CONTENT_TYPES = [
  "text/",
  "text/markdown",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ld+json",
];

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

type WebFetchRequestExecutor = (
  url: URL,
  options: {
    signal: AbortSignal;
    headers: Record<string, string>;
    resolvedAddress?: string;
  },
) => Promise<Response>;

type ExecuteWebFetchOptions = {
  resolveHostAddresses?: ResolveHostAddresses;
  requestExecutor?: WebFetchRequestExecutor;
  signal?: AbortSignal;
};

type NodeHttpResponseLike = {
  statusCode?: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
  resume: () => void;
} & Readable;

function parseMimeType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function clampInteger(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildAuthorizationHeader(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  const username = decodeUrlCredential(url.username);
  const password = decodeUrlCredential(url.password);
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(
    "base64",
  );
  return `Basic ${encoded}`;
}

function buildRequestHeaders(
  baseHeaders: Record<string, string>,
  url: URL,
): Record<string, string> {
  const headers = { ...baseHeaders };
  const authorization = buildAuthorizationHeader(url);
  if (authorization) {
    headers.authorization = authorization;
  } else {
    delete headers.authorization;
  }
  return headers;
}

function buildResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      responseHeaders.append(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
    }
  }
  return responseHeaders;
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

// The WHATWG `Response` constructor only accepts 101 or the range 200–599 and
// throws a `RangeError` for anything else. Some servers — notably anti-bot
// gateways like LinkedIn and various job boards — reply with non-standard codes
// such as 999. Map those onto 502 so we can still build a Response; the real
// upstream status is preserved via `upstreamStatusByResponse` for reporting.
// See https://developer.mozilla.org/en-US/docs/Web/API/Response/Response
const RESPONSE_STATUS_SWITCHING_PROTOCOLS = 101;
const RESPONSE_STATUS_MIN = 200;
const RESPONSE_STATUS_MAX = 599;

function toConstructableStatus(status: number): number {
  if (status === RESPONSE_STATUS_SWITCHING_PROTOCOLS) return status;
  if (status >= RESPONSE_STATUS_MIN && status <= RESPONSE_STATUS_MAX) {
    return status;
  }
  return 502;
}

const upstreamStatusByResponse = new WeakMap<Response, number>();

// Returns the real status the upstream server sent, which may fall outside the
// range the `Response` object can represent (e.g. 999). Falls back to
// `response.status` for responses built by native `fetch`, whose undici
// implementation already exposes non-standard codes directly.
export function getUpstreamStatus(response: Response): number {
  return upstreamStatusByResponse.get(response) ?? response.status;
}

export function buildFetchResponseFromNodeResponse(
  res: NodeHttpResponseLike,
): Response {
  const upstreamStatus = res.statusCode ?? 502;
  const status = toConstructableStatus(upstreamStatus);
  const responseHeaders = buildResponseHeaders(res.headers);
  const statusText = res.statusMessage ?? "";

  const response = isNullBodyStatus(status)
    ? // Drain any unexpected bytes and produce a valid null-body fetch Response.
      (res.resume(),
      new Response(null, { status, statusText, headers: responseHeaders }))
    : new Response(Readable.toWeb(res) as unknown as BodyInit, {
        status,
        statusText,
        headers: responseHeaders,
      });

  if (status !== upstreamStatus) {
    upstreamStatusByResponse.set(response, upstreamStatus);
  }
  return response;
}

function createAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

async function withAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const defaultRequestExecutor: WebFetchRequestExecutor = async (
  url,
  options,
) => {
  const resolvedAddress = options.resolvedAddress
    ? unwrapBracketedHostname(options.resolvedAddress)
    : undefined;

  if (!resolvedAddress) {
    const requestUrl = stripUrlUserinfo(url);
    return fetch(requestUrl.href, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
      headers: options.headers,
    });
  }

  const targetHost = unwrapBracketedHostname(url.hostname);
  const isHttps = url.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const requestHeaders = { ...options.headers, host: buildHostHeader(url) };
  const requestOptions: HttpsRequestOptions = {
    method: "GET",
    protocol: url.protocol,
    hostname: resolvedAddress,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    headers: requestHeaders,
    signal: options.signal,
  };

  if (isIPv4(resolvedAddress)) {
    requestOptions.family = 4;
  } else if (isIPv6(resolvedAddress)) {
    requestOptions.family = 6;
  }

  if (isHttps && !isIPv4(targetHost) && !isIPv6(targetHost)) {
    requestOptions.servername = targetHost;
  }

  return await new Promise<Response>((resolve, reject) => {
    const req = requestFn(requestOptions, (res) => {
      // Building the fetch Response runs inside this HTTP `response` event
      // callback. Any synchronous throw here would escape as an uncaught
      // exception and crash the daemon, so funnel failures into `reject` to
      // keep them local to this request.
      try {
        resolve(buildFetchResponseFromNodeResponse(res));
      } catch (err) {
        res.resume();
        reject(err);
      }
    });
    req.once("error", reject);
    req.end();
  });
};

function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;
  const mimeType = parseMimeType(contentType);
  if (!mimeType) return true;
  return TEXT_LIKE_CONTENT_TYPES.some((pattern) => {
    if (pattern.endsWith("/")) {
      return mimeType.startsWith(pattern);
    }
    return mimeType === pattern;
  });
}

function isMarkdownContentType(contentType: string): boolean {
  const mimeType = parseMimeType(contentType);
  return mimeType === "text/markdown";
}

function isHtmlContentType(contentType: string): boolean {
  const mimeType = parseMimeType(contentType);
  return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#(?:x|X)[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const value = Number.parseInt(entity.slice(2), 16);
        if (Number.isNaN(value) || value < 0 || value > 0x10ffff) return match;
        return String.fromCodePoint(value);
      }

      if (entity.startsWith("#")) {
        const value = Number.parseInt(entity.slice(1), 10);
        if (Number.isNaN(value) || value < 0 || value > 0x10ffff) return match;
        return String.fromCodePoint(value);
      }

      return HTML_ENTITY_MAP[entity] ?? match;
    },
  );
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Lighter normalization for markdown that preserves indentation, multiple spaces,
// and trailing whitespace - all of which carry semantic meaning in markdown
// (code blocks, nested lists, table alignment, line breaks).
function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<template[\s\S]*?<\/template>/gi, " ");
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(
    /<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|table|thead|tbody|tfoot|tr|blockquote|pre)\b[^>]*>/gi,
    "\n",
  );
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  return normalizeText(text);
}

function extractFirstMatch(
  text: string,
  regex: RegExp,
  captureGroup = 1,
): string | undefined {
  const match = regex.exec(text);
  if (!match) return undefined;
  const captured = match[captureGroup];
  if (typeof captured !== "string") return undefined;
  const value = normalizeText(decodeHtmlEntities(captured));
  return value || undefined;
}

const MAX_TITLE_CHARS = 200;

/**
 * Parse the first HTML `<title>` element from a response body.
 *
 * Used to populate {@link WebFetchMetadata.title}. Returns `undefined`
 * when no `<title>` is present. The result is HTML-entity-decoded and
 * capped at {@link MAX_TITLE_CHARS} characters so client UIs never have
 * to truncate.
 */
function parseHtmlTitle(html: string): string | undefined {
  // Bound the search to the first 200KB to avoid scanning huge bodies.
  const searchRegion = safeStringSlice(html, 0, 200_000);
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(searchRegion);
  if (!match) return undefined;
  const decoded = decodeHtmlEntities(match[1]).trim();
  if (!decoded) return undefined;
  return safeStringSlice(decoded, 0, MAX_TITLE_CHARS);
}

function extractHtmlMetadata(html: string): {
  title?: string;
  description?: string;
} {
  // Only search the <head> section (or first 50KB) to avoid catastrophic
  // regex backtracking on large HTML documents.
  // Strip <script> blocks first so that a literal "</head>" inside a script
  // doesn't cause a false match that truncates the search region prematurely.
  const candidate = safeStringSlice(html, 0, 200_000);
  const stripped = candidate.replace(/<script[\s>][\s\S]*?<\/script>/gi, "");
  const headEnd = stripped.search(/<\/head[\s>]/i);
  const searchRegion =
    headEnd >= 0
      ? safeStringSlice(stripped, 0, headEnd + 10)
      : safeStringSlice(stripped, 0, 50_000);

  const title = extractFirstMatch(
    searchRegion,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  );
  const description =
    extractFirstMatch(
      searchRegion,
      /<meta\s+[^>]*name=(['"])description\1[^>]*content=(['"])([\s\S]*?)\2[^>]*>/i,
      3,
    ) ??
    extractFirstMatch(
      searchRegion,
      /<meta\s+[^>]*content=(['"])([\s\S]*?)\1[^>]*name=(['"])description\3[^>]*>/i,
      2,
    ) ??
    extractFirstMatch(
      searchRegion,
      /<meta\s+[^>]*property=(['"])og:description\1[^>]*content=(['"])([\s\S]*?)\2[^>]*>/i,
      3,
    ) ??
    extractFirstMatch(
      searchRegion,
      /<meta\s+[^>]*content=(['"])([\s\S]*?)\1[^>]*property=(['"])og:description\3[^>]*>/i,
      2,
    );

  return { title, description };
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  if (!response.body) {
    return { text: "", bytesRead: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const nextTotal = total + value.byteLength;
    if (nextTotal > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        const partial = value.subarray(0, remaining);
        chunks.push(partial);
        total += partial.byteLength;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors.
      }
      break;
    }

    chunks.push(value);
    total = nextTotal;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(merged);
  return { text, bytesRead: total, truncated };
}

function formatWebFetchOutput(params: {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  bytesRead: number;
  totalChars: number;
  startIndex: number;
  endIndex: number;
  content: string;
  title?: string;
  description?: string;
  notices: string[];
  raw: boolean;
  markdown?: boolean;
  markdownTokens?: string;
}): string {
  let mode = "extracted";
  if (params.markdown) mode = "markdown";
  else if (params.raw) mode = "raw";

  const lines: string[] = [
    `Requested URL: ${params.requestedUrl}`,
    `Final URL: ${params.finalUrl}`,
    `Status: ${params.status}${params.statusText ? ` ${params.statusText}` : ""}`,
    `Content-Type: ${params.contentType || "unknown"}`,
    `Fetched Bytes: ${params.bytesRead}`,
    `Character Window: ${params.startIndex}-${params.endIndex} of ${params.totalChars}`,
    `Mode: ${mode}`,
  ];

  if (params.markdownTokens) {
    lines.push(`Markdown-Tokens: ${params.markdownTokens}`);
  }

  if (params.notices.length > 0) {
    lines.push("Notices:");
    for (const notice of params.notices) {
      lines.push(`- ${notice}`);
    }
  }

  lines.push("");
  lines.push("Content:");

  const contentParts: string[] = [];
  if (params.title) {
    contentParts.push(`Title: ${params.title}`);
  }
  if (params.description) {
    contentParts.push(`Description: ${params.description}`);
  }
  if (contentParts.length > 0) {
    contentParts.push("");
  }
  contentParts.push(params.content || "<no_content />");

  lines.push(
    wrapUntrustedContent(contentParts.join("\n"), {
      source: "web",
      sourceDetail: params.finalUrl,
    }),
  );

  return lines.join("\n");
}

export async function executeWebFetch(
  input: Record<string, unknown>,
  options?: ExecuteWebFetchOptions,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();

  /**
   * Build a {@link ToolExecutionResult} for an early-exit error path (bad
   * input, blocked target, timeout, bad content-type, HTTP error, ...).
   * Always attaches structured {@link WebFetchMetadata} so client UIs can
   * still render failed visits.
   */
  const buildErrorResult = (
    errorMessage: string,
    meta: {
      url: string;
      finalUrl?: string;
      status?: number;
      contentType?: string;
      redirectCount?: number;
    },
  ): ToolExecutionResult => {
    const safeUrl = sanitizeUrlStringForOutput(meta.url);
    const safeFinalUrl = meta.finalUrl
      ? sanitizeUrlStringForOutput(meta.finalUrl)
      : safeUrl;
    const domain = extractDomain(safeFinalUrl);
    return {
      content: errorMessage,
      isError: true,
      activityMetadata: {
        webFetch: {
          url: safeUrl,
          finalUrl: safeFinalUrl,
          provider: "default",
          status: meta.status ?? 0,
          contentType: meta.contentType,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          domain,
          faviconUrl: faviconUrlForDomain(domain),
          redirectCount: meta.redirectCount ?? 0,
          durationMs: Date.now() - startedAt,
          errorMessage,
        },
      },
    };
  };

  const parsedUrl = parseUrl(input.url);
  if (!parsedUrl) {
    return buildErrorResult(
      "Error: url is required and must be a valid HTTP(S) URL",
      { url: typeof input.url === "string" ? input.url : "" },
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return buildErrorResult("Error: url must use http or https", {
      url: parsedUrl.href,
    });
  }

  const allowPrivateNetwork = input.allow_private_network === true;
  const resolveHost = options?.resolveHostAddresses ?? resolveHostAddresses;
  const requestExecutor = options?.requestExecutor ?? defaultRequestExecutor;

  if (!allowPrivateNetwork && isPrivateOrLocalHost(parsedUrl.hostname)) {
    return buildErrorResult(
      `Error: Refusing to fetch local/private network target (${parsedUrl.hostname}). Set allow_private_network=true if you explicitly need it.`,
      { url: parsedUrl.href },
    );
  }
  const timeoutSeconds = clampInteger(
    input.timeout_seconds,
    DEFAULT_TIMEOUT_SECONDS,
    1,
    MAX_TIMEOUT_SECONDS,
  );
  const maxChars = clampInteger(
    input.max_chars,
    DEFAULT_MAX_CHARS,
    1,
    MAX_MAX_CHARS,
  );
  const startIndex = clampInteger(input.start_index, 0, 0, 10_000_000);
  const rawMode = input.raw === true;
  const requestedUrl = parsedUrl.href;
  const safeRequestedUrl = sanitizeUrlForOutput(parsedUrl);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    log.warn(
      { url: safeRequestedUrl, timeoutSeconds },
      "Web fetch timeout fired, aborting",
    );
    controller.abort();
  }, timeoutSeconds * 1000);

  // Forward external cancellation signal to our controller
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  let currentUrl = new URL(requestedUrl);
  let redirectCount = 0;

  try {
    log.debug(
      { url: safeRequestedUrl, timeoutSeconds, maxChars, startIndex, rawMode },
      "Fetching webpage",
    );

    const requestHeaders = {
      Accept:
        "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.6",
      "Accept-Encoding": "identity",
      "User-Agent":
        process.env.HTTP_USER_AGENT ||
        "VellumAssistant/1.0 (+https://vellum.ai)",
    };

    let response: Response | null = null;
    let currentResolvedAddresses: string[] | undefined;

    if (!allowPrivateNetwork) {
      const resolution = await withAbortSignal(
        resolveRequestAddress(
          currentUrl.hostname,
          resolveHost,
          allowPrivateNetwork,
        ),
        controller.signal,
      );
      if (resolution.blockedAddress) {
        return buildErrorResult(
          `Error: Refusing to fetch target (${currentUrl.hostname}) because it resolves to local/private network address ${resolution.blockedAddress}. Set allow_private_network=true if you explicitly need it.`,
          { url: requestedUrl, finalUrl: currentUrl.href, redirectCount },
        );
      }
      if (resolution.addresses.length === 0) {
        return buildErrorResult(
          `Error: Unable to resolve host "${currentUrl.hostname}" while fetching ${safeRequestedUrl}`,
          { url: requestedUrl, finalUrl: currentUrl.href, redirectCount },
        );
      }
      currentResolvedAddresses = resolution.addresses;
    }

    while (true) {
      const headers = buildRequestHeaders(requestHeaders, currentUrl);
      const addressesToTry =
        currentResolvedAddresses && currentResolvedAddresses.length > 0
          ? currentResolvedAddresses
          : [undefined];

      response = null;
      let lastRequestError: unknown;
      for (let i = 0; i < addressesToTry.length; i++) {
        try {
          response = await requestExecutor(currentUrl, {
            signal: controller.signal,
            headers,
            resolvedAddress: addressesToTry[i],
          });
          break;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw err;
          }
          lastRequestError = err;
          if (i === addressesToTry.length - 1) {
            throw lastRequestError;
          }
        }
      }
      currentResolvedAddresses = undefined;

      if (!response) {
        return buildErrorResult(
          "Error: Web fetch failed: no response returned",
          { url: requestedUrl, finalUrl: currentUrl.href, redirectCount },
        );
      }

      const upstreamStatus = getUpstreamStatus(response);
      const location = response.headers.get("location");
      const isRedirect =
        upstreamStatus >= 300 && upstreamStatus < 400 && !!location;
      if (!isRedirect) break;

      if (redirectCount >= MAX_REDIRECTS) {
        return buildErrorResult(
          `Error: Too many redirects (>${MAX_REDIRECTS}) while fetching ${safeRequestedUrl}`,
          {
            url: requestedUrl,
            finalUrl: currentUrl.href,
            status: getUpstreamStatus(response),
            redirectCount,
          },
        );
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location!, currentUrl);
      } catch {
        const safeLocation = sanitizeUrlStringForOutput(
          location ?? "",
          currentUrl,
        );
        const safeCurrentUrl = sanitizeUrlForOutput(currentUrl);
        return buildErrorResult(
          `Error: Invalid redirect location "${safeLocation}" received from ${safeCurrentUrl}`,
          {
            url: requestedUrl,
            finalUrl: currentUrl.href,
            status: getUpstreamStatus(response),
            redirectCount,
          },
        );
      }

      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        return buildErrorResult(
          `Error: Refusing redirect to unsupported protocol "${nextUrl.protocol}"`,
          {
            url: requestedUrl,
            finalUrl: currentUrl.href,
            status: getUpstreamStatus(response),
            redirectCount,
          },
        );
      }

      if (!allowPrivateNetwork && isPrivateOrLocalHost(nextUrl.hostname)) {
        return buildErrorResult(
          `Error: Refusing redirect to local/private network target (${nextUrl.hostname}). Set allow_private_network=true if you explicitly need it.`,
          {
            url: requestedUrl,
            finalUrl: currentUrl.href,
            status: getUpstreamStatus(response),
            redirectCount,
          },
        );
      }
      if (!allowPrivateNetwork) {
        const resolution = await withAbortSignal(
          resolveRequestAddress(
            nextUrl.hostname,
            resolveHost,
            allowPrivateNetwork,
          ),
          controller.signal,
        );
        if (resolution.blockedAddress) {
          return buildErrorResult(
            `Error: Refusing redirect to target (${nextUrl.hostname}) because it resolves to local/private network address ${resolution.blockedAddress}. Set allow_private_network=true if you explicitly need it.`,
            {
              url: requestedUrl,
              finalUrl: currentUrl.href,
              status: getUpstreamStatus(response),
              redirectCount,
            },
          );
        }
        if (resolution.addresses.length === 0) {
          const safeCurrentUrl = sanitizeUrlForOutput(currentUrl);
          return buildErrorResult(
            `Error: Unable to resolve redirect host "${nextUrl.hostname}" from ${safeCurrentUrl}`,
            {
              url: requestedUrl,
              finalUrl: currentUrl.href,
              status: getUpstreamStatus(response),
              redirectCount,
            },
          );
        }
        currentResolvedAddresses = resolution.addresses;
      }

      currentUrl = nextUrl;
      redirectCount++;
    }

    if (!response) {
      return buildErrorResult("Error: Web fetch failed: no response returned", {
        url: requestedUrl,
        finalUrl: currentUrl.href,
        redirectCount,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextLikeContentType(contentType)) {
      return buildErrorResult(
        `Error: Unsupported content type "${contentType || "unknown"}". web_fetch only supports text-like responses.`,
        {
          url: requestedUrl,
          finalUrl: currentUrl.href,
          status: getUpstreamStatus(response),
          contentType,
          redirectCount,
        },
      );
    }

    const body = await readResponseText(response, MAX_DOWNLOAD_BYTES);
    const markdown = isMarkdownContentType(contentType);
    const html =
      !markdown && (isHtmlContentType(contentType) || looksLikeHtml(body.text));
    const metadata = html ? extractHtmlMetadata(body.text) : {};
    const markdownTokens =
      response.headers.get("x-markdown-tokens") ?? undefined;

    let processed = body.text.replace(/\0/g, "");
    if (markdown) {
      processed = normalizeMarkdown(processed);
    } else if (html && !rawMode) {
      processed = htmlToText(processed);
    } else {
      processed = normalizeText(processed);
    }

    const safeStart = Math.min(startIndex, processed.length);
    const safeEnd = Math.min(processed.length, safeStart + maxChars);
    const sliced = processed.slice(safeStart, safeEnd);
    const notices: string[] = [];

    if (body.truncated) {
      notices.push(
        `Response body exceeded ${MAX_DOWNLOAD_BYTES} bytes and was truncated.`,
      );
    }
    if (redirectCount > 0) {
      notices.push(`Followed ${redirectCount} redirect(s).`);
    }
    if (safeEnd < processed.length) {
      notices.push(`Output truncated by max_chars=${maxChars}.`);
    }
    if (startIndex > processed.length) {
      notices.push(
        `start_index (${startIndex}) exceeded available content length (${processed.length}).`,
      );
    }
    // Detect likely JS-rendered SPAs: text is absolutely tiny, or a non-trivial
    // HTML payload compresses to almost nothing (a shell page whose meaningful
    // content is painted after fetch + document.body rewrite).
    const lowAbsolute = processed.length < 200;
    const lowRatio =
      body.bytesRead >= 10_000 && processed.length / body.bytesRead < 0.05;
    const mayRequireJavaScript = html && !rawMode && (lowAbsolute || lowRatio);
    if (mayRequireJavaScript) {
      const pct =
        body.bytesRead > 0
          ? ((processed.length / body.bytesRead) * 100).toFixed(1)
          : "0";
      notices.push(
        `Extracted only ${processed.length} chars of text from ${body.bytesRead} bytes of HTML (${pct}%). Content may be JavaScript-rendered — the static fetch likely missed dynamically injected content.`,
      );
    }

    const content = formatWebFetchOutput({
      requestedUrl: safeRequestedUrl,
      finalUrl: sanitizeUrlForOutput(currentUrl),
      status: getUpstreamStatus(response),
      statusText: response.statusText,
      contentType,
      bytesRead: body.bytesRead,
      totalChars: processed.length,
      startIndex: safeStart,
      endIndex: safeEnd,
      content: sliced,
      title: metadata.title,
      description: metadata.description,
      notices,
      raw: rawMode,
      markdown,
      markdownTokens,
    });

    const truncated = body.truncated || safeEnd < processed.length;
    const parsedTitle = html ? parseHtmlTitle(body.text) : undefined;
    const finalDomain = extractDomain(currentUrl.href);
    const meta: WebFetchMetadata = {
      url: safeRequestedUrl,
      finalUrl: sanitizeUrlForOutput(currentUrl),
      provider: "default",
      status: getUpstreamStatus(response),
      contentType: contentType || undefined,
      byteCount: body.bytesRead,
      charCount: sliced.length,
      truncated,
      title: parsedTitle,
      domain: finalDomain,
      faviconUrl: faviconUrlForDomain(finalDomain),
      redirectCount,
      durationMs: Date.now() - startedAt,
      mayRequireJavaScript: mayRequireJavaScript || undefined,
    };

    if (!response.ok) {
      const errorMessage = `Error: HTTP ${getUpstreamStatus(response)}`;
      return {
        content: `${errorMessage}\n\n${content}`,
        isError: true,
        status: notices.length > 0 ? notices.join("\n") : undefined,
        activityMetadata: { webFetch: { ...meta, errorMessage } },
      };
    }

    return {
      content,
      isError: false,
      status: notices.length > 0 ? notices.join("\n") : undefined,
      activityMetadata: { webFetch: meta },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        return buildErrorResult("Error: web fetch was cancelled", {
          url: requestedUrl,
          finalUrl: currentUrl.href,
          redirectCount,
        });
      }
      return buildErrorResult(
        `Error: web fetch timed out after ${timeoutSeconds}s`,
        { url: requestedUrl, finalUrl: currentUrl.href, redirectCount },
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, url: safeRequestedUrl }, "Web fetch failed");
    return buildErrorResult(`Error: Web fetch failed: ${msg}`, {
      url: requestedUrl,
      finalUrl: currentUrl.href,
      redirectCount,
    });
  } finally {
    clearTimeout(timeoutHandle);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ----------------------------------------------------------------------------
// Provider abstraction
//
// `web_fetch` defaults to the built-in fetcher above (`executeWebFetch`). When
// `services.web-fetch.provider` selects a BYOK provider (e.g. `firecrawl`),
// the tool routes through that provider's hosted API instead — which can read
// JavaScript-rendered pages the static fetcher can't. The provider's stored
// key is shared with its web-search counterpart (one `firecrawl` key powers
// both tools). The dispatcher falls back to the built-in fetcher when the
// provider has no key, or when the target is a private/local host the hosted
// scraper can't reach.
// ----------------------------------------------------------------------------

interface FirecrawlScrapeMetadata {
  title?: string;
  description?: string;
  sourceURL?: string;
  url?: string;
  statusCode?: number;
  contentType?: string;
  error?: string;
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: FirecrawlScrapeMetadata;
    warning?: string | null;
  };
  warning?: string | null;
  error?: string;
}

function getWebFetchProvider(): WebFetchProviderId {
  const configured = getConfig().services["web-fetch"]?.provider ?? "default";
  return configured === "firecrawl" ? "firecrawl" : "default";
}

/**
 * Decide whether a request may be routed to the hosted Firecrawl provider.
 *
 * Posting a URL to Firecrawl sends its path + query (which can hold secrets) to
 * a third party, so we apply the SAME safety gate as the built-in fetcher
 * BEFORE dispatching — not just the lexical host check:
 *   - only http(s) URLs (Firecrawl can't do other schemes anyway),
 *   - never `allow_private_network` requests (those are intentionally local;
 *     Firecrawl can't reach them and the built-in path owns that mode),
 *   - and a DNS resolution check so a public hostname that resolves to a
 *     private/blocked address (e.g. `internal.example` → 10.x.x.x) is NOT
 *     leaked to Firecrawl.
 * Anything that fails falls back to the built-in fetcher, which enforces its
 * own SSRF rules and returns the appropriate error.
 */
async function canRouteToFirecrawl(
  input: Record<string, unknown>,
): Promise<boolean> {
  if (input.allow_private_network === true) return false;
  const parsed = parseUrl(input.url);
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isPrivateOrLocalHost(parsed.hostname)) return false;
  try {
    const resolution = await resolveRequestAddress(
      parsed.hostname,
      resolveHostAddresses,
      false,
    );
    if (resolution.blockedAddress || resolution.addresses.length === 0) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function firecrawlErrorResult(
  requestedUrl: string,
  startedAt: number,
  errorMessage: string,
  status = 0,
): ToolExecutionResult {
  const domain = extractDomain(requestedUrl);
  return {
    content: `Error: ${errorMessage}`,
    isError: true,
    activityMetadata: {
      webFetch: {
        url: requestedUrl,
        finalUrl: requestedUrl,
        provider: "firecrawl",
        status,
        byteCount: 0,
        charCount: 0,
        truncated: false,
        domain,
        faviconUrl: faviconUrlForDomain(domain),
        redirectCount: 0,
        durationMs: Date.now() - startedAt,
        errorMessage,
      },
    },
  };
}

/**
 * Fetch a page via Firecrawl's hosted `/v2/scrape` endpoint, returning clean
 * markdown. Mirrors the built-in fetcher's output shape (same
 * {@link formatWebFetchOutput} and {@link WebFetchMetadata}) so the model and
 * client UIs can't tell which backend served the page apart from
 * `metadata.provider`.
 *
 * Exported for direct unit testing; the registered tool dispatches here via
 * {@link getWebFetchProvider}.
 */
export async function executeFirecrawlScrape(
  input: Record<string, unknown>,
  options: { apiKey: string; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const parsedUrl = parseUrl(input.url);
  const targetUrl =
    parsedUrl?.href ?? (typeof input.url === "string" ? input.url : "");
  const safeRequestedUrl = parsedUrl
    ? sanitizeUrlForOutput(parsedUrl)
    : sanitizeUrlStringForOutput(targetUrl);

  if (!targetUrl) {
    return firecrawlErrorResult(
      safeRequestedUrl,
      startedAt,
      "url is required and must be a valid HTTP(S) URL",
    );
  }

  // Never forward URL-embedded credentials (user:password@host) to the hosted
  // Firecrawl API. The built-in fetcher turns them into a Basic-auth header to
  // the target; Firecrawl can't, so reject rather than leak them to a third
  // party.
  if (parsedUrl?.username || parsedUrl?.password) {
    return firecrawlErrorResult(
      safeRequestedUrl,
      startedAt,
      "URLs with embedded credentials are not supported by the Firecrawl provider. Remove the user:password@ portion of the URL.",
    );
  }

  const maxChars = clampInteger(
    input.max_chars,
    DEFAULT_MAX_CHARS,
    1,
    MAX_MAX_CHARS,
  );
  const startIndex = clampInteger(input.start_index, 0, 0, 10_000_000);
  const timeoutSeconds = clampInteger(
    input.timeout_seconds,
    DEFAULT_TIMEOUT_SECONDS,
    1,
    MAX_TIMEOUT_SECONDS,
  );

  const requestBody = {
    url: targetUrl,
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: timeoutSeconds * 1000,
  };

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(FIRECRAWL_SCRAPE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
          "X-Client-Source": "vellum-assistant",
        },
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });
    } catch (err) {
      if (
        options.signal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return firecrawlErrorResult(
          safeRequestedUrl,
          startedAt,
          "web fetch was cancelled",
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return firecrawlErrorResult(
        safeRequestedUrl,
        startedAt,
        `Firecrawl scrape failed: ${msg}`,
      );
    }

    if (response.ok) {
      let json: FirecrawlScrapeResponse;
      try {
        json = (await response.json()) as FirecrawlScrapeResponse;
      } catch {
        return firecrawlErrorResult(
          safeRequestedUrl,
          startedAt,
          "Firecrawl scrape returned an invalid JSON payload.",
          response.status,
        );
      }
      const data = json.data ?? {};
      const fcMeta = data.metadata ?? {};
      // A 200 can still carry a payload-level failure (success:false, a
      // top-level error, or a per-page error in data.metadata). Surface it
      // instead of treating an empty body as a successful "no content" scrape.
      const payloadError = json.error ?? fcMeta.error;
      if (json.success === false || payloadError) {
        return firecrawlErrorResult(
          safeRequestedUrl,
          startedAt,
          payloadError ?? "Firecrawl scrape failed.",
          response.status,
        );
      }
      const processed = normalizeMarkdown(
        (data.markdown ?? "").replace(/\0/g, ""),
      );

      const safeStart = Math.min(startIndex, processed.length);
      const safeEnd = Math.min(processed.length, safeStart + maxChars);
      const sliced = processed.slice(safeStart, safeEnd);
      const bytesRead = Buffer.byteLength(processed, "utf8");

      const finalUrlRaw = fcMeta.url ?? fcMeta.sourceURL ?? targetUrl;
      const finalUrl = sanitizeUrlStringForOutput(finalUrlRaw);
      const status = fcMeta.statusCode ?? 200;
      const contentType = fcMeta.contentType ?? "text/markdown";

      const notices: string[] = [];
      const warning = data.warning ?? json.warning;
      if (warning) notices.push(`Firecrawl: ${warning}`);
      if (safeEnd < processed.length) {
        notices.push(`Output truncated by max_chars=${maxChars}.`);
      }
      if (startIndex > processed.length) {
        notices.push(
          `start_index (${startIndex}) exceeded available content length (${processed.length}).`,
        );
      }

      const content = formatWebFetchOutput({
        requestedUrl: safeRequestedUrl,
        finalUrl,
        status,
        statusText: "",
        contentType,
        bytesRead,
        totalChars: processed.length,
        startIndex: safeStart,
        endIndex: safeEnd,
        content: sliced,
        title: fcMeta.title,
        description: fcMeta.description,
        notices,
        raw: false,
        markdown: true,
      });

      const finalDomain = extractDomain(finalUrl);
      const meta: WebFetchMetadata = {
        url: safeRequestedUrl,
        finalUrl,
        provider: "firecrawl",
        status,
        contentType,
        byteCount: bytesRead,
        charCount: sliced.length,
        truncated: safeEnd < processed.length,
        title: fcMeta.title,
        domain: finalDomain,
        faviconUrl: faviconUrlForDomain(finalDomain),
        redirectCount: 0,
        durationMs: Date.now() - startedAt,
      };

      return {
        content,
        isError: false,
        status: notices.length > 0 ? notices.join("\n") : undefined,
        activityMetadata: { webFetch: meta },
      };
    }

    const bodyText = await response.text();

    if (response.status === 401 || response.status === 403) {
      return firecrawlErrorResult(
        safeRequestedUrl,
        startedAt,
        "Invalid or expired Firecrawl API key",
        response.status,
      );
    }

    if (response.status === 429 && attempt < DEFAULT_MAX_RETRIES) {
      const delayMs = getHttpRetryDelay(
        response,
        attempt,
        DEFAULT_BASE_DELAY_MS,
      );
      log.warn(
        { attempt: attempt + 1, delayMs },
        "Firecrawl scrape rate limited, retrying",
      );
      await sleep(delayMs);
      continue;
    }

    log.warn(
      { status: response.status, body: safeStringSlice(bodyText, 0, 200) },
      "Firecrawl scrape API error",
    );
    const errorMessage =
      response.status === 429
        ? "Firecrawl scrape rate limit exceeded after retries. Try again shortly."
        : response.status === 402
          ? "Firecrawl scrape failed: account balance/credits exhausted."
          : `Firecrawl scrape API returned status ${response.status}`;
    return firecrawlErrorResult(
      safeRequestedUrl,
      startedAt,
      errorMessage,
      response.status,
    );
  }

  return firecrawlErrorResult(
    safeRequestedUrl,
    startedAt,
    "Firecrawl scrape rate limit exceeded after retries. Try again shortly.",
    429,
  );
}

export const webFetchTool = {
  name: "web_fetch",
  description:
    "Fetch a webpage and return LLM-friendly extracted text with metadata. Use this after web_search when you need to read a specific result. To find pages on a site without guessing slugs, fetch /sitemap.xml first — it has ground-truth paths and works even when pages are JS-rendered.",
  category: "network",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The target webpage URL. If scheme is missing, https:// is assumed.",
      },
      max_chars: {
        type: "number",
        description: `Maximum characters of content to return (1-${MAX_MAX_CHARS}, default ${DEFAULT_MAX_CHARS})`,
      },
      start_index: {
        type: "number",
        description:
          "Character index to start returning content from (default 0). Useful for paging large pages.",
      },
      timeout_seconds: {
        type: "number",
        description: `Request timeout in seconds (1-${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS})`,
      },
      raw: {
        type: "boolean",
        description:
          "If true, return normalized raw response text instead of extracted plain text for HTML pages.",
      },
      allow_private_network: {
        type: "boolean",
        description:
          "If true, allows requests to localhost/private-network hosts. Disabled by default for SSRF safety.",
      },
    },
    required: ["url"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (
      getWebFetchProvider() === "firecrawl" &&
      (await canRouteToFirecrawl(input))
    ) {
      const apiKey = await getProviderKeyAsync("firecrawl");
      if (apiKey) {
        return executeFirecrawlScrape(input, {
          apiKey,
          signal: context.signal,
        });
      }
      log.info(
        "web_fetch provider is firecrawl but no API key is configured; falling back to the built-in fetcher",
      );
      // Fall through to the built-in fetcher.
    }
    return executeWebFetch(input, { signal: context.signal });
  },
} satisfies ToolDefinition;
