import { isbot } from "isbot";
import { NextRequest, NextResponse } from "next/server";

/**
 * Attribution-only port of the platform marketing proxy
 * (vellum-assistant-platform `web/src/proxy.ts`): page_view logging, the
 * `vellum_vid` visitor cookie, and UTM/click-ID capture. The page_view JSON
 * contract is parsed downstream (BigQuery log sink + dbt
 * `stg_marketing_events__page_views`); field names must not change.
 *
 * NEXT.JS MIDDLEWARE WORKAROUND: `request.nextUrl.hostname` returns the server
 * bind address (0.0.0.0) behind a reverse proxy (GKE L7 load balancer), not the
 * public hostname, so all host-based checks in this file read the Host header
 * directly. See https://github.com/vercel/next.js/issues/37536.
 */

const APEX_DOMAIN = "vellum.ai";
const VELLUM_COOKIE_DOMAIN = ".vellum.ai";

function isVellumDomain(host: string): boolean {
  return host === APEX_DOMAIN || host.endsWith(`.${APEX_DOMAIN}`);
}

const VID_COOKIE_NAME = "vellum_vid";
const VID_MAX_AGE = 90 * 24 * 60 * 60; // 90 days, same as the platform proxy

const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

function buildUTMPayload(request: NextRequest): Record<string, string> | null {
  const params = request.nextUrl.searchParams;
  const utmValues: Record<string, string> = {};
  for (const key of UTM_PARAMS) {
    const value = params.get(key);
    if (value) {
      utmValues[key] = value;
    }
  }

  if (Object.keys(utmValues).length === 0) {
    return null;
  }

  // Backfill utm_medium for known AI sources when only utm_source is present
  if (utmValues.utm_source && !utmValues.utm_medium) {
    const src = utmValues.utm_source.toLowerCase();
    if (
      src.includes("chatgpt") ||
      src.includes("openai") ||
      src.includes("claude") ||
      src.includes("anthropic") ||
      src.includes("perplexity") ||
      src.includes("gemini") ||
      src.includes("copilot") ||
      src.includes("grok") ||
      src.includes("deepseek") ||
      src.includes("meta-ai") ||
      src.includes("meta ai")
    ) {
      utmValues.utm_medium = "geo";
    }
  }

  return {
    ...utmValues,
    landing_page: request.nextUrl.pathname,
    referrer: request.headers.get("referer") || "",
  };
}

/**
 * Paid click IDs appended by ad platforms when auto-tagging is enabled.
 * A URL with one of these, even without explicit utm_* params, is paid traffic.
 */
const PAID_CLICK_IDS: ReadonlyArray<{
  params: readonly string[];
  source: string;
  medium: string;
}> = [
  { params: ["gclid", "gbraid", "wbraid"], source: "google", medium: "cpc" },
  { params: ["msclkid"], source: "bing", medium: "cpc" },
  { params: ["fbclid"], source: "facebook", medium: "paid_social" },
  { params: ["li_fat_id"], source: "linkedin", medium: "paid_social" },
  { params: ["twclid"], source: "x", medium: "paid_social" },
  { params: ["ttclid"], source: "tiktok", medium: "paid_social" },
];

const CLICK_ID_PARAMS: readonly string[] = PAID_CLICK_IDS.flatMap(
  (rule) => rule.params,
);

// Mirrors the platform's cap (_CLICK_ID_FIELD_MAX_LENGTHS in Django's
// marketing_attribution middleware).
const CLICK_ID_MAX_LENGTH = 512;

const LOGGED_ATTRIBUTION_KEYS: readonly string[] = [
  ...UTM_PARAMS,
  ...CLICK_ID_PARAMS,
];

/** Raw click ID params present in the URL, for log persistence. */
function pickClickIds(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of CLICK_ID_PARAMS) {
    const value = request.nextUrl.searchParams.get(param);
    if (value) {
      out[param] = value.slice(0, CLICK_ID_MAX_LENGTH);
    }
  }
  return out;
}

function inferUTMFromClickIds(
  request: NextRequest,
): Record<string, string> | null {
  const searchParams = request.nextUrl.searchParams;
  for (const rule of PAID_CLICK_IDS) {
    for (const param of rule.params) {
      // Nonempty only, matching pickClickIds: a bare `?gclid=` must not
      // produce a paid row with no supporting click ID in the payload.
      if (searchParams.get(param)) {
        return {
          utm_source: rule.source,
          utm_medium: rule.medium,
          landing_page: request.nextUrl.pathname,
          referrer: request.headers.get("referer") || "",
        };
      }
    }
  }
  return null;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostMatchesAny(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostMatches(host, domain));
}

// Google search spans ccTLDs (google.com, google.co.uk, google.de, ...), so a
// suffix match against a fixed domain can't cover it. Require "google" to be
// the registrable label: the suffix must be a bare TLD (com, de, fr, ...) or a
// known second-level country form (co.uk, com.au, ...). This rejects
// lookalikes (notgoogle.com), embedded brands (google.com.evil.org), and
// third-party registrable domains carrying a google label (google.example.org).
const GOOGLE_SEARCH_HOST =
  /(^|\.)google\.(com|cat|[a-z]{2}|(co|com)\.[a-z]{2})$/;

function inferUTMFromReferrer(
  request: NextRequest,
): Record<string, string> | null {
  const referrer = request.headers.get("referer") || "";
  if (!referrer) {
    return null;
  }

  let host = "";
  try {
    // hostname, not host: an explicit port would defeat the exact/suffix
    // matches below.
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }

  // Don't infer for same-site navigation
  const currentHost =
    request.headers.get("host")?.split(":")[0]?.replace(/^www\./, "") ?? "";
  const refHost = host.replace(/^www\./, "");
  if (refHost === currentHost) {
    return null;
  }

  let source: string | undefined;
  let medium: string | undefined;

  // Search engines
  if (
    GOOGLE_SEARCH_HOST.test(host) &&
    !hostMatches(host, "gemini.google.com")
  ) {
    source = "google";
    medium = "organic";
  } else if (
    hostMatches(host, "bing.com") &&
    !hostMatches(host, "copilot.bing.com")
  ) {
    source = "bing";
    medium = "organic";
  } else if (hostMatches(host, "duckduckgo.com")) {
    source = "duckduckgo";
    medium = "organic";
  } else if (hostMatches(host, "search.yahoo.com")) {
    source = "yahoo";
    medium = "organic";
  } else if (hostMatches(host, "baidu.com")) {
    source = "baidu";
    medium = "organic";
  } else if (hostMatches(host, "search.brave.com")) {
    source = "brave";
    medium = "organic";
  } else if (hostMatches(host, "kagi.com")) {
    source = "kagi";
    medium = "organic";
  } else if (hostMatches(host, "ecosia.org")) {
    source = "ecosia";
    medium = "organic";
  } else if (hostMatches(host, "yandex.ru") || hostMatches(host, "yandex.com")) {
    source = "yandex";
    medium = "organic";
  }
  // AI engines (GEO = generative engine optimization)
  else if (
    hostMatchesAny(host, ["chat.openai.com", "chatgpt.com", "r.openai.com"])
  ) {
    source = "chatgpt";
    medium = "geo";
  } else if (hostMatchesAny(host, ["claude.ai", "anthropic.com"])) {
    source = "claude";
    medium = "geo";
  } else if (hostMatches(host, "perplexity.ai")) {
    source = "perplexity";
    medium = "geo";
  } else if (hostMatches(host, "gemini.google.com")) {
    source = "gemini";
    medium = "geo";
  } else if (
    hostMatchesAny(host, ["copilot.microsoft.com", "copilot.bing.com"])
  ) {
    source = "copilot";
    medium = "geo";
  } else if (hostMatches(host, "grok.com")) {
    source = "grok";
    medium = "geo";
  } else if (hostMatches(host, "deepseek.com")) {
    source = "deepseek";
    medium = "geo";
  } else if (hostMatches(host, "meta.ai")) {
    source = "meta-ai";
    medium = "geo";
  }
  // Social
  else if (hostMatchesAny(host, ["x.com", "twitter.com", "t.co"])) {
    source = "x";
    medium = "social";
  } else if (
    hostMatches(host, "linkedin.com") ||
    // LinkedIn's link shortener and Android app referrer
    host === "lnkd.in" ||
    host === "com.linkedin.android"
  ) {
    source = "linkedin";
    medium = "social";
  } else if (hostMatchesAny(host, ["facebook.com", "instagram.com"])) {
    source = "facebook";
    medium = "social";
  } else if (hostMatches(host, "youtube.com")) {
    source = "youtube";
    medium = "social";
  } else if (hostMatches(host, "reddit.com")) {
    source = "reddit";
    medium = "social";
  } else if (hostMatches(host, "tiktok.com")) {
    source = "tiktok";
    medium = "social";
  } else if (hostMatches(host, "threads.net")) {
    source = "threads";
    medium = "social";
  } else if (hostMatches(host, "bsky.app")) {
    source = "bluesky";
    medium = "social";
  } else if (hostMatches(host, "news.ycombinator.com")) {
    source = "hackernews";
    medium = "social";
  } else if (hostMatches(host, "producthunt.com")) {
    source = "producthunt";
    medium = "social";
  } else if (hostMatches(host, "github.com")) {
    source = "github";
    medium = "referral";
  } else if (
    hostMatches(host, "teams.microsoft.com") ||
    hostMatches(host, "teams.cdn.office.net")
  ) {
    source = "teams";
    medium = "referral";
  }
  // Generic referral
  else {
    source = refHost;
    medium = "referral";
  }

  if (!source) {
    return null;
  }

  return {
    utm_source: source,
    utm_medium: medium!,
    landing_page: request.nextUrl.pathname,
    referrer,
  };
}

/**
 * Docs page paths only: exclude API routes, the agent-markdown mirror, and
 * file-like paths (static assets, `.md` variants, sitemap.xml, llms.txt).
 */
function isPagePath(pathname: string): boolean {
  if (pathname !== "/docs" && !pathname.startsWith("/docs/")) {
    return false;
  }
  if (pathname === "/docs/api" || pathname.startsWith("/docs/api/")) {
    return false;
  }
  if (pathname === "/docs/_md" || pathname.startsWith("/docs/_md/")) {
    return false;
  }
  if (pathname.startsWith("/docs/_next/")) {
    return false;
  }
  const lastSegment = pathname.split("/").at(-1) ?? "";
  return !lastSegment.includes(".");
}

function isPrefetch(request: NextRequest): boolean {
  if (request.headers.has("Next-Router-Prefetch")) {
    return true;
  }
  // Next 16's segment cache prefetches with one request per route segment,
  // carrying this header instead of Next-Router-Prefetch.
  if (request.headers.has("Next-Router-Segment-Prefetch")) {
    return true;
  }
  const secPurpose = request.headers.get("Sec-Purpose") ?? "";
  const purpose = request.headers.get("Purpose") ?? "";
  return secPurpose.includes("prefetch") || purpose.includes("prefetch");
}

function emitPageViewLog(
  request: NextRequest,
  vid: string,
  pathname: string,
  attribution: EntryAttribution | null,
): void {
  const entry: Record<string, string> = {
    source: "marketing",
    event: "page_view",
    vid,
    path: pathname,
    referrer: request.headers.get("referer") || "",
    timestamp: new Date().toISOString(),
  };
  if (attribution) {
    for (const key of LOGGED_ATTRIBUTION_KEYS) {
      if (attribution.payload[key]) {
        entry[key] = attribution.payload[key];
      }
    }
    entry.utm_resolution = attribution.resolution;
  }
  console.info(JSON.stringify(entry));
}

function resolveVisitorId(request: NextRequest): string {
  return request.cookies.get(VID_COOKIE_NAME)?.value ?? crypto.randomUUID();
}

function setVisitorIdCookie(
  request: NextRequest,
  host: string,
  response: Response,
  vid: string,
): void {
  if (request.cookies.get(VID_COOKIE_NAME)?.value) {
    return;
  }

  const secure = request.nextUrl.protocol === "https:";
  const domain = isVellumDomain(host) ? `; Domain=${VELLUM_COOKIE_DOMAIN}` : "";
  response.headers.append(
    "Set-Cookie",
    `${VID_COOKIE_NAME}=${vid}; Path=/; Max-Age=${VID_MAX_AGE}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}${domain}`,
  );
}

type EntryAttribution = {
  payload: Record<string, string>;
  /** How utm_source/utm_medium were determined for this entry. */
  resolution: "explicit" | "click_id" | "referrer";
};

/**
 * Resolve the attribution for this request: explicit UTM params win, then
 * paid click IDs (gclid, fbclid, etc.), then referrer inference. Merged
 * payloads keep explicit params (e.g. utm_campaign) on top of inferred
 * source/medium.
 */
function resolveEntryAttribution(
  request: NextRequest,
): EntryAttribution | null {
  const explicit = buildUTMPayload(request);
  // Click IDs ride along on the payload regardless of how source/medium
  // resolve, so the warehouse can attribute paid entries. They can only be
  // present in the first two branches; any nonempty click ID in the URL makes
  // inferUTMFromClickIds match.
  const clickIds = pickClickIds(request);

  if (explicit?.utm_source) {
    // Explicit source always wins (last-touch for paid campaigns)
    return {
      payload: { ...explicit, ...clickIds },
      resolution: "explicit",
    };
  }

  const clickIdPayload = inferUTMFromClickIds(request);
  if (clickIdPayload) {
    return {
      payload: {
        ...(explicit ? { ...clickIdPayload, ...explicit } : clickIdPayload),
        ...clickIds,
      },
      resolution: "click_id",
    };
  }

  const inferred = inferUTMFromReferrer(request);

  // Explicit UTM params without source (e.g. just ?utm_campaign=...): use
  // referrer inference to fill in source/medium when available
  if (explicit) {
    return {
      payload: inferred ? { ...inferred, ...explicit } : explicit,
      resolution: inferred ? "referrer" : "explicit",
    };
  }

  if (!inferred) {
    return null;
  }
  return { payload: inferred, resolution: "referrer" };
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0] ?? "";
  const rawPathname = request.nextUrl.pathname;

  // skipMiddlewareUrlNormalize keeps the pathname percent-encoded, so decode
  // once up front: the exclusion checks and the logged path must agree, or an
  // encoded mirror path like /docs/%5Fmd/... would slip past the /docs/_md
  // exclusion and log a phantom page_view.
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }

  const response = NextResponse.next();
  const vid = resolveVisitorId(request);
  setVisitorIdCookie(request, host, response, vid);

  const userAgent = request.headers.get("user-agent") || "";
  if (
    request.method === "GET" &&
    isPagePath(pathname) &&
    !isbot(userAgent) &&
    !isPrefetch(request)
  ) {
    emitPageViewLog(request, vid, pathname, resolveEntryAttribution(request));
  }
  return response;
}

export const config = {
  matcher: ["/docs/:path*"],
};
