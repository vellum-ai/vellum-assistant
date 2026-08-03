import { describe, expect, test } from "bun:test";
// Next.js compiles rewrite `source`/`destination` strings with its own vendored
// path-to-regexp, so exercising the rules through the same module validates the
// real routing behavior (pattern shape, ordering, and `.md` suffix stripping)
// rather than re-implementing the matcher.
import { compile, match } from "next/dist/compiled/path-to-regexp";

import nextConfig from "./next.config";

interface HeaderCondition {
  type: string;
  key: string;
  value?: string;
}

interface RewriteRule {
  source: string;
  destination: string;
  has?: HeaderCondition[];
}

type RewriteResult =
  | RewriteRule[]
  | {
      beforeFiles?: RewriteRule[];
      afterFiles?: RewriteRule[];
      fallback?: RewriteRule[];
    };

interface RedirectRule {
  source: string;
  destination: string;
  permanent: boolean;
}

interface ConfigWithRewrites {
  rewrites?: () => Promise<RewriteResult>;
  redirects?: () => Promise<RedirectRule[]>;
}

async function beforeFilesRewrites(): Promise<RewriteRule[]> {
  const rewrites = (nextConfig as ConfigWithRewrites).rewrites;
  if (!rewrites) {
    throw new Error("nextConfig.rewrites is missing");
  }

  const result = await rewrites();
  return Array.isArray(result) ? result : (result.beforeFiles ?? []);
}

function hasMarkdownAcceptCondition(rule: RewriteRule): boolean {
  return (
    rule.has?.some(
      (condition) =>
        condition.type === "header" &&
        condition.key.toLowerCase() === "accept" &&
        condition.value?.includes("text/markdown")
    ) ?? false
  );
}

/** Resolves the docs path a markdown rewrite source captures for a pathname.
 *  Every source string is matched explicitly; an unrecognized source throws so
 *  new rewrites cannot land without test coverage. */
function docsPathForSource(source: string, pathname: string): string | null {
  if (source === "/docs") {
    return pathname === "/docs" ? "" : null;
  }

  const prefix = "/docs/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const docsPath = pathname.slice(prefix.length);
  if (
    source ===
    "/docs/:path((?!llms\\.txt$)(?!api(?:\\/|$))(?!_md(?:\\/|$)).*)"
  ) {
    if (
      docsPath === "llms.txt" ||
      docsPath === "api" ||
      docsPath.startsWith("api/") ||
      docsPath === "_md" ||
      docsPath.startsWith("_md/")
    ) {
      return null;
    }
    return docsPath;
  }

  throw new Error(`Unsupported docs markdown rewrite source: ${source}`);
}

async function markdownRewriteDestinationsFor(
  pathname: string
): Promise<string[]> {
  const rewrites = await beforeFilesRewrites();
  return rewrites.filter(hasMarkdownAcceptCondition).flatMap((rule) => {
    const docsPath = docsPathForSource(rule.source, pathname);
    if (docsPath === null) {
      return [];
    }

    return [rule.destination.replace("/:path", docsPath ? `/${docsPath}` : "")];
  });
}

// Mirror the matching options Next.js uses for custom-route sources.
const PATH_TO_REGEXP_OPTIONS = {
  delimiter: "/",
  sensitive: false,
  strict: false,
} as const;

function acceptConditionSatisfied(
  rule: RewriteRule,
  accept: string | null
): boolean {
  const acceptCondition = rule.has?.find(
    (condition) =>
      condition.type === "header" && condition.key.toLowerCase() === "accept"
  );
  if (!acceptCondition) {
    return true;
  }
  if (!accept) {
    return false;
  }
  return acceptCondition.value
    ? new RegExp(acceptCondition.value).test(accept)
    : true;
}

/**
 * Resolves a request through the beforeFiles rewrites the same way Next.js
 * does: first matching rule (in declared order) whose source and `has`
 * conditions are satisfied wins, and its destination is compiled from the
 * captured params. Returns null when nothing matches (request falls through
 * to filesystem/page routing).
 */
async function resolveBeforeFilesRewrite(
  pathname: string,
  accept: string | null = null
): Promise<string | null> {
  const rules = await beforeFilesRewrites();
  for (const rule of rules) {
    if (!acceptConditionSatisfied(rule, accept)) {
      continue;
    }
    const matched = match(rule.source, PATH_TO_REGEXP_OPTIONS)(pathname);
    if (!matched) {
      continue;
    }
    return compile(rule.destination, { validate: false })(matched.params);
  }
  return null;
}

describe("next config rewrite sources", () => {
  test("every beforeFiles rewrite source is a known pattern", async () => {
    const sources = (await beforeFilesRewrites()).map((rule) => rule.source);
    expect(sources).toEqual([
      "/docs/_next/:path*",
      "/docs/index.md",
      "/docs/:path*.md",
      "/docs",
      "/docs/:path((?!llms\\.txt$)(?!api(?:\\/|$))(?!_md(?:\\/|$)).*)",
    ]);
  });

  test("the asset rewrite is first and maps the assetPrefix back to /_next", async () => {
    const [assetRule] = await beforeFilesRewrites();
    expect(assetRule.source).toBe("/docs/_next/:path*");
    expect(assetRule.destination).toBe("/_next/:path*");
    expect(hasMarkdownAcceptCondition(assetRule)).toBe(false);
  });

  test("docsPathForSource rejects unrecognized sources", () => {
    expect(() => docsPathForSource("/docs/:path*", "/docs/pricing")).toThrow(
      "Unsupported docs markdown rewrite source"
    );
  });
});

describe("next config redirects", () => {
  test("the redirect set is pinned exactly", async () => {
    const redirects = (nextConfig as ConfigWithRewrites).redirects;
    if (!redirects) {
      throw new Error("nextConfig.redirects is missing");
    }

    await expect(redirects()).resolves.toEqual([
      {
        source: "/docs/data-sharing",
        destination: "/docs/privacy-policy",
        permanent: true,
      },
      {
        source: "/docs/affiliate-program-rules",
        destination: "/docs",
        permanent: true,
      },
      {
        source: "/docs/vellum-survey-giveaway-official-rules",
        destination: "/docs",
        permanent: true,
      },
    ]);
  });
});

describe("next config .md URL-suffix rewrites", () => {
  test.each([
    ["/docs/index.md", "/docs/_md"],
    ["/docs/pricing.md", "/docs/_md/pricing"],
    ["/docs/getting-started.md", "/docs/_md/getting-started"],
    ["/docs/skills-reference/browser.md", "/docs/_md/skills-reference/browser"],
  ])("maps %s to %s", async (pathname, destination) => {
    await expect(resolveBeforeFilesRewrite(pathname)).resolves.toBe(
      destination
    );
  });

  test("a .md request wins over the permissive docs Accept rule regardless of Accept header", async () => {
    // The docs Accept rule uses a `.*` capture that would otherwise swallow
    // the `.md` suffix and 404. The suffix rules are declared first so they
    // win.
    await expect(
      resolveBeforeFilesRewrite("/docs/getting-started.md", "text/markdown, */*")
    ).resolves.toBe("/docs/_md/getting-started");
    await expect(
      resolveBeforeFilesRewrite("/docs/index.md", "text/markdown, */*")
    ).resolves.toBe("/docs/_md");
  });

  test.each([["/docs"], ["/docs/getting-started"], ["/docs/llms.txt"]])(
    "does not add a .md rewrite for %s",
    async (pathname) => {
      await expect(resolveBeforeFilesRewrite(pathname)).resolves.toBeNull();
    }
  );
});

describe("next config docs Markdown content negotiation", () => {
  test("rewrites the docs index for markdown-preferring clients", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs", "text/markdown")
    ).resolves.toBe("/docs/_md");
  });

  test("rewrites docs pages for markdown-preferring clients", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/getting-started", "text/markdown")
    ).resolves.toBe("/docs/_md/getting-started");
    await expect(
      markdownRewriteDestinationsFor("/docs/getting-started")
    ).resolves.toEqual(["/docs/_md/getting-started"]);
  });

  test("matches text/markdown anywhere in the Accept header", async () => {
    await expect(
      resolveBeforeFilesRewrite(
        "/docs/pricing",
        "application/json;q=0.9, text/markdown;q=0.8"
      )
    ).resolves.toBe("/docs/_md/pricing");
  });

  test("does not rewrite when markdown is explicitly unacceptable (q=0)", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/pricing", "text/html, text/markdown;q=0")
    ).resolves.toBeNull();
    await expect(
      resolveBeforeFilesRewrite("/docs/pricing", "text/markdown;q=0.0")
    ).resolves.toBeNull();
    await expect(
      resolveBeforeFilesRewrite("/docs/pricing", "text/markdown; q=0, */*")
    ).resolves.toBeNull();
    await expect(
      resolveBeforeFilesRewrite(
        "/docs/pricing",
        "text/markdown;charset=utf-8;q=0"
      )
    ).resolves.toBeNull();
    await expect(
      resolveBeforeFilesRewrite("/docs/pricing", "text/markdown;level=1;q=0")
    ).resolves.toBeNull();
  });

  test("serves HTML (no rewrite) to browsers", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/pricing", "text/html,application/xhtml+xml")
    ).resolves.toBeNull();
    await expect(resolveBeforeFilesRewrite("/docs")).resolves.toBeNull();
  });

  test("does not rewrite the docs llms.txt index", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/llms.txt", "text/markdown")
    ).resolves.toBeNull();
    await expect(markdownRewriteDestinationsFor("/docs/llms.txt")).resolves.toEqual(
      []
    );
  });

  test("does not rewrite the /docs/api subtree", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/api/health", "text/markdown")
    ).resolves.toBeNull();
    await expect(
      markdownRewriteDestinationsFor("/docs/api/health")
    ).resolves.toEqual([]);
  });

  test("does not rewrite the bare /docs/api path", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/api", "text/markdown")
    ).resolves.toBeNull();
    await expect(markdownRewriteDestinationsFor("/docs/api")).resolves.toEqual(
      []
    );
  });

  test("does not re-enter the mirror route itself", async () => {
    await expect(
      resolveBeforeFilesRewrite("/docs/_md/pricing", "text/markdown")
    ).resolves.toBeNull();
    await expect(
      markdownRewriteDestinationsFor("/docs/_md/pricing")
    ).resolves.toEqual([]);
    await expect(
      resolveBeforeFilesRewrite("/docs/_md", "text/markdown")
    ).resolves.toBeNull();
  });

  test("the _md exclusion is anchored to the exact subtree", async () => {
    // Only /docs/_md and /docs/_md/... are excluded; an _md-prefixed sibling
    // path still negotiates.
    await expect(
      resolveBeforeFilesRewrite("/docs/_mdsomething", "text/markdown")
    ).resolves.toBe("/docs/_md/_mdsomething");
  });
});
