/**
 * End-to-end parity verification for the docs app against the platform route
 * snapshot (scripts/platform-route-snapshot.json). Written for the Phase 1
 * port sign-off and reusable for the Phase 3 production cutover: point it at
 * any running instance (local `next start`, the Docker image, or the deployed
 * backend).
 *
 * Usage: bun scripts/verify-parity.ts <base-url>
 * Example: bun scripts/verify-parity.ts http://localhost:3000
 *
 * Asserts, against the running instance:
 * - the app's filesystem route tree matches the snapshot
 * - every route serves HTML with the canonical https://www.vellum.ai<path>
 *   (redirect stubs must redirect to another docs route instead)
 * - every route's `.md` mirror and its Accept: text/markdown negotiation
 *   variant return markdown with identical bodies
 * - /docs/llms.txt exists and /docs/sitemap.xml lists exactly the non-stub
 *   routes
 * - /docs/api/search returns at least one result
 * - the legal paths native clients link to respond 200
 */
import { join } from "node:path";

import {
  discoverDocsRoutes,
  REDIRECT_STUB_ROUTES,
} from "../src/lib/discover-docs-routes";
import { agentMarkdownPathForPage } from "../src/lib/agent-markdown-paths";
import { SITE_URL } from "../src/lib/metadata";
import { routes as urlRegistry } from "../src/lib/routes";
import snapshot from "./platform-route-snapshot.json";

const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 15_000;

// Bound every request so a target that accepts connections but never
// responds fails the run instead of hanging the worker pool.
function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

const baseUrl = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!baseUrl) {
  console.error("Usage: bun scripts/verify-parity.ts <base-url>");
  process.exit(1);
}

const snapshotRoutes: string[] = [...snapshot.routes].sort();
const failures: string[] = [];
let checksRun = 0;

function check(condition: boolean, message: string): void {
  checksRun += 1;
  if (!condition) {
    failures.push(message);
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function extractCanonical(html: string): string | null {
  const tag = html.match(/<link\b[^>]*rel="canonical"[^>]*>/);
  if (!tag) {
    return null;
  }
  const href = tag[0].match(/href="([^"]+)"/);
  return href ? href[1] : null;
}

function isMarkdownResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/markdown");
}

function verifyRouteTree(): void {
  const appRoutes = discoverDocsRoutes(
    join(import.meta.dir, "..", "src", "app", "docs"),
  );
  const missing = snapshotRoutes.filter((route) => !appRoutes.includes(route));
  const extra = appRoutes.filter((route) => !snapshotRoutes.includes(route));
  check(
    missing.length === 0,
    `route tree: missing platform routes: ${missing.join(", ")}`,
  );
  check(
    extra.length === 0,
    `route tree: routes absent from the platform snapshot: ${extra.join(", ")}`,
  );
}

async function verifyHtml(route: string): Promise<void> {
  const res = await fetchWithTimeout(`${baseUrl}${route}`, { redirect: "manual" });

  if (REDIRECT_STUB_ROUTES.has(route)) {
    check(
      res.status >= 300 && res.status < 400,
      `${route}: expected a redirect, got ${res.status}`,
    );
    const location = res.headers.get("location") ?? "";
    check(
      location.startsWith("/docs") || location.startsWith(`${SITE_URL}/docs`),
      `${route}: redirect target ${location} is not a docs path`,
    );
    const followed = await fetchWithTimeout(`${baseUrl}${route}`);
    check(
      followed.status === 200,
      `${route}: followed redirect returned ${followed.status}`,
    );
    return;
  }

  check(res.status === 200, `${route}: expected 200, got ${res.status}`);
  if (res.status !== 200) {
    return;
  }
  const canonical = extractCanonical(await res.text());
  check(
    canonical === `${SITE_URL}${route}`,
    `${route}: canonical is ${canonical ?? "missing"}, expected ${SITE_URL}${route}`,
  );
}

async function verifyMarkdown(route: string): Promise<void> {
  const mdPath = agentMarkdownPathForPage(route);
  if (!mdPath) {
    check(false, `${route}: no markdown alternate path`);
    return;
  }

  // Redirect stubs are excluded from the mirror generation; their `.md` URL
  // must 404 rather than serve a "moved" page to agents.
  if (REDIRECT_STUB_ROUTES.has(route)) {
    const stub = await fetchWithTimeout(`${baseUrl}${mdPath}`);
    check(
      stub.status === 404,
      `${mdPath}: expected 404 for a redirect stub mirror, got ${stub.status}`,
    );
    return;
  }

  const mirror = await fetchWithTimeout(`${baseUrl}${mdPath}`);
  check(mirror.status === 200, `${mdPath}: expected 200, got ${mirror.status}`);
  check(isMarkdownResponse(mirror), `${mdPath}: content-type is not markdown`);
  const mirrorBody = await mirror.text();
  check(mirrorBody.trim().length > 0, `${mdPath}: empty markdown body`);

  const negotiated = await fetchWithTimeout(`${baseUrl}${route}`, {
    headers: { Accept: "text/markdown" },
  });
  check(
    negotiated.status === 200,
    `${route} (Accept: text/markdown): expected 200, got ${negotiated.status}`,
  );
  check(
    isMarkdownResponse(negotiated),
    `${route} (Accept: text/markdown): content-type is not markdown`,
  );
  const negotiatedBody = await negotiated.text();
  check(
    negotiatedBody === mirrorBody,
    `${route}: Accept-negotiated body differs from the ${mdPath} mirror`,
  );
}

async function verifyLlmsTxt(): Promise<void> {
  const res = await fetchWithTimeout(`${baseUrl}/docs/llms.txt`);
  check(res.status === 200, `/docs/llms.txt: expected 200, got ${res.status}`);
  const body = await res.text();
  check(
    body.startsWith("# Vellum Docs"),
    "/docs/llms.txt: unexpected content",
  );
  for (const route of REDIRECT_STUB_ROUTES) {
    check(
      !body.includes(`${route}.md`),
      `/docs/llms.txt: lists the redirect stub ${route}`,
    );
  }
}

async function verifySitemap(): Promise<void> {
  const res = await fetchWithTimeout(`${baseUrl}/docs/sitemap.xml`);
  check(
    res.status === 200,
    `/docs/sitemap.xml: expected 200, got ${res.status}`,
  );
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((entry) => entry[1])
    .sort();
  const expected = snapshotRoutes
    .filter((route) => !REDIRECT_STUB_ROUTES.has(route))
    .map((route) => `${SITE_URL}${route}`)
    .sort();
  const mismatches = [
    ...expected.filter((url) => !locs.includes(url)),
    ...locs.filter((url) => !expected.includes(url)),
  ];
  check(
    mismatches.length === 0 && locs.length === expected.length,
    `/docs/sitemap.xml: expected the ${expected.length} non-stub routes, ` +
      `got ${locs.length} entries; mismatched: ${mismatches.join(", ")}`,
  );
}

async function verifySearch(): Promise<void> {
  const res = await fetchWithTimeout(`${baseUrl}/docs/api/search?q=skill`);
  check(
    res.status === 200,
    `/docs/api/search?q=skill: expected 200, got ${res.status}`,
  );
  if (res.status !== 200) {
    return;
  }
  const body = (await res.json()) as { results?: unknown[] };
  check(
    Array.isArray(body.results) && body.results.length >= 1,
    `/docs/api/search?q=skill: expected >= 1 result, got ${body.results?.length ?? "none"}`,
  );
}

async function verifyLegalPaths(): Promise<void> {
  for (const path of Object.values(urlRegistry.docs.legal)) {
    const res = await fetchWithTimeout(`${baseUrl}${path}`);
    check(res.status === 200, `${path}: expected 200, got ${res.status}`);
  }
}

async function main(): Promise<void> {
  console.log(`Verifying docs parity against ${baseUrl}`);
  console.log(`Snapshot routes: ${snapshotRoutes.length}`);

  verifyRouteTree();
  await mapPool(snapshotRoutes, CONCURRENCY, verifyHtml);
  await mapPool(snapshotRoutes, CONCURRENCY, verifyMarkdown);
  await verifyLlmsTxt();
  await verifySitemap();
  await verifySearch();
  await verifyLegalPaths();

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} of ${checksRun} checks failed:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `\nPASS: ${checksRun} checks across ${snapshotRoutes.length} routes ` +
      "(HTML + canonical, .md mirror, Accept negotiation, llms.txt, sitemap, search, legal paths)",
  );
}

await main();
