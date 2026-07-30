import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

import { config, proxy } from "@/proxy";

const VID_COOKIE_NAME = "vellum_vid";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const consoleInfoMock = mock(() => {});
const originalConsoleInfo = console.info;

beforeEach(() => {
  consoleInfoMock.mockClear();
  console.info = consoleInfoMock;
});

afterEach(() => {
  console.info = originalConsoleInfo;
});

function request(
  url: string,
  {
    host = "www.vellum.ai",
    cookie,
    referrer,
    userAgent = BROWSER_UA,
    headers = {},
    method = "GET",
  }: {
    host?: string;
    cookie?: string;
    referrer?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): NextRequest {
  const req = new NextRequest(url, {
    method,
    headers: { "user-agent": userAgent, ...headers },
  });
  // host, cookie, and referer are Fetch-spec forbidden request headers;
  // Request() may strip them during construction. Set them after via
  // Headers.set(). Cookies must also be set on NextRequest's internal cookie
  // jar via req.cookies.set() since it doesn't re-read the raw header.
  req.headers.set("host", host);
  if (cookie) {
    req.headers.set("cookie", cookie);
    for (const pair of cookie.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name) {
        req.cookies.set(name, rest.join("="));
      }
    }
  }
  if (referrer) {
    req.headers.set("referer", referrer);
  }
  return req;
}

function vidSetCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie(): string[] };
  return headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${VID_COOKIE_NAME}=`));
}

function pageViewLogs(): Array<Record<string, string>> {
  return (consoleInfoMock.mock.calls as unknown as string[][])
    .map(([line]) => JSON.parse(line ?? "{}") as Record<string, string>)
    .filter((entry) => entry.event === "page_view");
}

describe("docs proxy page_view logging", () => {
  test("hitting /docs emits exactly one page_view line with a vid", () => {
    proxy(request("https://www.vellum.ai/docs"));

    const logs = pageViewLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.vid).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs[0]?.path).toBe("/docs");
  });

  test("nested docs pages are logged", () => {
    proxy(request("https://www.vellum.ai/docs/quickstart"));

    expect(pageViewLogs()[0]?.path).toBe("/docs/quickstart");
  });

  test.each([
    ["/docs/api/health", "API route"],
    ["/docs/api/search", "API route"],
    ["/docs/_md/quickstart", "agent-markdown mirror"],
    ["/docs/%5Fmd/quickstart", "percent-encoded agent-markdown mirror"],
    ["/docs/quickstart.md", "markdown variant"],
    ["/docs/sitemap.xml", "sitemap"],
    ["/docs/llms.txt", "llms.txt"],
    ["/docs/images/hero.webp", "static asset"],
    ["/pricing", "non-docs path"],
  ])("%s (%s) is not logged as a page view", (path) => {
    proxy(request(`https://www.vellum.ai${path}`));

    expect(pageViewLogs()).toHaveLength(0);
  });

  test("bot user agents are not logged", () => {
    proxy(
      request("https://www.vellum.ai/docs", {
        userAgent:
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
    );

    expect(pageViewLogs()).toHaveLength(0);
  });

  test.each([["HEAD"], ["POST"], ["OPTIONS"]])(
    "%s requests are not logged as page views",
    (method) => {
      proxy(request("https://www.vellum.ai/docs", { method }));

      expect(pageViewLogs()).toHaveLength(0);
    },
  );
});

describe("docs proxy prefetch filtering", () => {
  test.each([
    ["Next-Router-Segment-Prefetch", "/_tree"],
    ["Next-Router-Prefetch", "1"],
    ["Sec-Purpose", "prefetch"],
    ["Sec-Purpose", "prefetch;prerender"],
    ["Purpose", "prefetch"],
  ])("%s: %s requests are not logged as page views", (header, value) => {
    proxy(
      request("https://www.vellum.ai/docs", { headers: { [header]: value } }),
    );

    expect(pageViewLogs()).toHaveLength(0);
  });

  test("prefetch requests still mint the vid cookie", () => {
    const response = proxy(
      request("https://www.vellum.ai/docs", {
        headers: { "Next-Router-Segment-Prefetch": "/_tree" },
      }),
    );

    expect(vidSetCookie(response)).toBeDefined();
  });
});

describe("docs proxy visitor cookie", () => {
  test("mints a vid cookie when absent and logs the same vid", () => {
    const response = proxy(request("https://www.vellum.ai/docs"));

    const cookie = vidSetCookie(response);
    expect(cookie).toBeDefined();
    if (!cookie) {
      throw new Error("Expected vellum_vid cookie");
    }
    expect(cookie).toContain("Max-Age=7776000"); // 90 days
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const mintedVid = cookie.split(";")[0]?.split("=")[1];
    expect(pageViewLogs()[0]?.vid).toBe(mintedVid ?? "");
  });

  test("reuses an existing vid cookie without re-setting it", () => {
    const existingVid = "11111111-2222-3333-4444-555555555555";
    const response = proxy(
      request("https://www.vellum.ai/docs", {
        cookie: `${VID_COOKIE_NAME}=${existingVid}`,
      }),
    );

    expect(vidSetCookie(response)).toBeUndefined();
    expect(pageViewLogs()[0]?.vid).toBe(existingVid);
  });

  test("cookie is Domain=.vellum.ai when Host is www.vellum.ai", () => {
    const response = proxy(request("https://www.vellum.ai/docs"));

    expect(vidSetCookie(response)).toContain("Domain=.vellum.ai");
  });

  test("cookie is host-only (no Domain) on localhost dev", () => {
    const response = proxy(
      request("http://localhost:3005/docs", { host: "localhost" }),
    );

    const cookie = vidSetCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Secure");
  });
});

describe("docs proxy UTM/click-ID capture", () => {
  test("explicit UTM params are logged with explicit resolution", () => {
    proxy(
      request(
        "https://www.vellum.ai/docs?utm_source=linkedin&utm_medium=social&utm_campaign=launch",
      ),
    );

    expect(pageViewLogs()[0]).toMatchObject({
      path: "/docs",
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "launch",
      utm_resolution: "explicit",
    });
  });

  test("click IDs are logged raw alongside inferred paid attribution", () => {
    proxy(request("https://www.vellum.ai/docs?gclid=abc123"));

    expect(pageViewLogs()[0]).toMatchObject({
      utm_source: "google",
      utm_medium: "cpc",
      utm_resolution: "click_id",
      gclid: "abc123",
    });
  });

  test("an empty click ID param does not infer paid attribution", () => {
    proxy(request("https://www.vellum.ai/docs?gclid="));

    const [entry] = pageViewLogs();
    expect(entry?.utm_resolution).toBeUndefined();
    expect(entry?.utm_source).toBeUndefined();
    expect(entry?.gclid).toBeUndefined();
  });

  test("overlong click ID values are truncated to 512 chars", () => {
    proxy(request(`https://www.vellum.ai/docs?gclid=${"x".repeat(600)}`));

    expect(pageViewLogs()[0]?.gclid).toBe("x".repeat(512));
  });

  test("referrer-inferred attribution is logged with referrer resolution", () => {
    proxy(
      request("https://www.vellum.ai/docs/quickstart", {
        referrer: "https://chatgpt.com/c/abc123",
      }),
    );

    expect(pageViewLogs()[0]).toMatchObject({
      referrer: "https://chatgpt.com/c/abc123",
      utm_source: "chatgpt",
      utm_medium: "geo",
      utm_resolution: "referrer",
    });
  });

  test.each([
    ["https://www.google.com/", "google", "organic"],
    ["https://www.google.co.uk/", "google", "organic"],
    ["https://notgoogle.com/", "notgoogle.com", "referral"],
    ["https://x.com.example.org/", "x.com.example.org", "referral"],
    ["https://www.google.cat/", "google", "organic"],
    ["https://google.example.org/", "google.example.org", "referral"],
    ["https://mail.google.example.org/", "mail.google.example.org", "referral"],
    ["https://copilot.bing.com/", "copilot", "geo"],
    ["https://copilot.microsoft.com/", "copilot", "geo"],
  ])(
    "referrer %s classifies as source=%s medium=%s",
    (referrer, source, medium) => {
      proxy(request("https://www.vellum.ai/docs", { referrer }));

      expect(pageViewLogs()[0]).toMatchObject({
        utm_source: source,
        utm_medium: medium,
        utm_resolution: "referrer",
      });
    },
  );

  test("utm_source=chatgpt without utm_medium gets geo backfilled", () => {
    proxy(request("https://www.vellum.ai/docs?utm_source=chatgpt"));

    expect(pageViewLogs()[0]).toMatchObject({
      utm_source: "chatgpt",
      utm_medium: "geo",
    });
  });

  test("same-site referrer produces no attribution fields", () => {
    proxy(
      request("https://www.vellum.ai/docs", {
        referrer: "https://www.vellum.ai/",
      }),
    );

    const [entry] = pageViewLogs();
    expect(entry?.utm_source).toBeUndefined();
    expect(entry?.utm_resolution).toBeUndefined();
  });
});

describe("docs proxy JSON log contract", () => {
  // Key order copied from a platform page_view log line (the platform's
  // emitPageViewLog in vellum-assistant-platform web/src/proxy.ts); the
  // BigQuery sink + dbt stg_marketing_events__page_views parse this shape.
  const PLATFORM_FIXTURE = {
    source: "marketing",
    event: "page_view",
    vid: "0d4f5be2-9c11-4e08-9f4e-3a9d1a3f6b7e",
    path: "/plugins/cognee",
    referrer: "https://t.co/Xc0y1brRmQ",
    timestamp: "2026-07-21T18:04:11.132Z",
    utm_source: "x",
    utm_medium: "social",
    utm_resolution: "referrer",
  };

  test("attributed page_view lines match the platform key set and order", () => {
    proxy(
      request("https://www.vellum.ai/docs", {
        referrer: "https://t.co/Xc0y1brRmQ",
      }),
    );

    const [entry] = pageViewLogs();
    expect(Object.keys(entry ?? {})).toEqual(Object.keys(PLATFORM_FIXTURE));
    expect(entry).toMatchObject({
      source: "marketing",
      event: "page_view",
      referrer: "https://t.co/Xc0y1brRmQ",
      utm_source: "x",
      utm_medium: "social",
      utm_resolution: "referrer",
    });
    expect(entry?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("direct-traffic lines carry only the six base keys", () => {
    proxy(request("https://www.vellum.ai/docs"));

    const [entry] = pageViewLogs();
    expect(Object.keys(entry ?? {})).toEqual([
      "source",
      "event",
      "vid",
      "path",
      "referrer",
      "timestamp",
    ]);
  });
});

describe("docs proxy matcher", () => {
  test("is scoped to /docs", () => {
    expect(config.matcher).toEqual(["/docs/:path*"]);
  });
});
