let cached: string | null = null;

type BrowserMetadata = {
  browserFamily?: string;
  browserVersion?: string;
  os?: string;
  interfaceVersion?: string;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>;
    platform?: string;
  };
};

const SAFE_HEADER_VALUE_RE = /^[a-z0-9._-]{1,64}$/;

function safeHeaderValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return SAFE_HEADER_VALUE_RE.test(normalized) ? normalized : undefined;
}

function detectBrowserFromBrands(
  brands: Array<{ brand: string; version: string }> | undefined,
): Pick<BrowserMetadata, "browserFamily" | "browserVersion"> {
  if (!brands || brands.length === 0) return {};

  const ordered = [
    { family: "edge", pattern: /microsoft edge|edge/i },
    { family: "chrome", pattern: /google chrome|chromium|chrome/i },
  ] as const;

  for (const { family, pattern } of ordered) {
    const match = brands.find((brand) => pattern.test(brand.brand));
    const version = match?.version.match(/^\d+/)?.[0];
    if (match) {
      return {
        browserFamily: family,
        ...(version ? { browserVersion: version } : {}),
      };
    }
  }

  return {};
}

function detectBrowserFromUserAgent(
  userAgent: string,
): Pick<BrowserMetadata, "browserFamily" | "browserVersion"> {
  const patterns = [
    { family: "edge", pattern: /(?:Edg|EdgiOS|EdgA)\/(\d+)/ },
    { family: "chrome", pattern: /(?:Chrome|CriOS|Chromium)\/(\d+)/ },
    { family: "firefox", pattern: /(?:Firefox|FxiOS)\/(\d+)/ },
    { family: "safari", pattern: /Version\/(\d+).*Safari\// },
  ] as const;

  for (const { family, pattern } of patterns) {
    const match = userAgent.match(pattern);
    if (match) {
      return {
        browserFamily: family,
        browserVersion: match[1],
      };
    }
  }

  return {};
}

function detectOs(nav: NavigatorWithUserAgentData): string | undefined {
  const platform = nav.userAgentData?.platform || nav.platform || "";
  const platformLower = platform.toLowerCase();
  const ua = nav.userAgent;

  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (platformLower.includes("mac") && nav.maxTouchPoints > 1) return "ios";
  if (/android/i.test(ua) || platformLower.includes("android"))
    return "android";
  if (platformLower.includes("mac")) return "macos";
  if (platformLower.includes("win")) return "windows";
  if (platformLower.includes("cros")) return "chromeos";
  if (platformLower.includes("linux")) return "linux";
  return undefined;
}

function getClientMetadata(): BrowserMetadata {
  if (typeof navigator === "undefined") return {};

  const nav = navigator as NavigatorWithUserAgentData;
  const brandBrowser = detectBrowserFromBrands(nav.userAgentData?.brands);
  const uaBrowser =
    brandBrowser.browserFamily || brandBrowser.browserVersion
      ? {}
      : detectBrowserFromUserAgent(nav.userAgent);

  return {
    ...brandBrowser,
    ...uaBrowser,
    os: detectOs(nav),
    interfaceVersion: import.meta.env.VITE_APP_VERSION,
  };
}

/**
 * Returns a UUID identifying this page load.
 *
 * Generated on first call, cached in module memory for the rest of the
 * page's lifetime. Not persisted anywhere — each page load (initial nav,
 * reload, duplicated tab, restored bfcache entry) produces a fresh id.
 *
 * This is the unit the assistant daemon's self-echo suppression keys off:
 * a mutation and the SSE subscriber that should be skipped both come from
 * the same page-load `getClientId()` call, so they always match. Two tabs
 * (or duplicates of one) never collide because each got its own module
 * initialization.
 */
export function getClientId(): string {
  if (cached) return cached;
  cached = crypto.randomUUID();
  return cached;
}

/**
 * Headers identifying this web client to the assistant daemon.
 *
 * Attach to:
 *   - Long-lived SSE connections (so the hub's ClientRegistry can track
 *     the subscriber and its interface capabilities).
 *   - Every HTTP request (so the daemon can echo the id back on the
 *     resulting `sync_changed` and the hub can skip the originator's SSE
 *     subscriber).
 *
 * The central interceptor at `lib/api-interceptors.ts` attaches these to
 * all generated-client requests; raw `fetch` call sites still call this
 * helper directly.
 */
export function getClientRegistrationHeaders(): Record<string, string> {
  const metadata = getClientMetadata();
  const headers: Record<string, string> = {
    "X-Vellum-Client-Id": getClientId(),
    "X-Vellum-Interface-Id": "vellum",
  };

  const browserFamily = safeHeaderValue(metadata.browserFamily);
  if (browserFamily) headers["X-Vellum-Browser-Family"] = browserFamily;

  const browserVersion = safeHeaderValue(metadata.browserVersion);
  if (browserVersion) headers["X-Vellum-Browser-Version"] = browserVersion;

  const os = safeHeaderValue(metadata.os);
  if (os) headers["X-Vellum-Client-OS"] = os;

  const interfaceVersion = safeHeaderValue(metadata.interfaceVersion);
  if (interfaceVersion) {
    headers["X-Vellum-Interface-Version"] = interfaceVersion;
  }

  return headers;
}
