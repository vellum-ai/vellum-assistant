/**
 * Generates Markdown mirrors of every /docs page for AI-agent consumption.
 *
 * Each docs page.tsx is rendered to static HTML (page component only, no
 * layout chrome), the DocsContent prose is converted to Markdown, and the
 * result is written to generated/md/ starting straight at the H1, with no
 * YAML frontmatter. Agents receive these files via the Accept: text/markdown
 * and `.md`-suffix rewrites in next.config.ts (served by the /docs/_md route,
 * src/app/docs/%5Fmd/[[...slug]]/route.ts); the canonical URL travels in the
 * Link response header, not the body.
 *
 * Page metadata (title, description) is emitted to a sidecar JSON index
 * (generated/md/docs-index.json), so the mirror bodies stay pure prose. The
 * agent index at public/docs/llms.txt is built from the same metadata.
 *
 * Runs before `next build` and `next dev` (see the prebuild/predev scripts in
 * package.json) so the generated files ship with the deploy.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "cheerio";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import {
  discoverDocsPages,
  REDIRECT_STUB_ROUTES,
} from "../src/lib/discover-docs-routes";
import { SITE_URL } from "../src/lib/metadata";
import { loadPageMetadata, renderPage } from "./lib/docs-pages";
import { buildLlmsText, type DocsPageMeta } from "./lib/llms-text";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_PAGES_ROOT = join(ROOT, "src", "app", "docs");
const OUTPUT_ROOT = join(ROOT, "generated", "md");
const DOCS_INDEX_OUTPUT = join(OUTPUT_ROOT, "docs-index.json");
const DOCS_PUBLIC_ROOT = join(ROOT, "public", "docs");
const LLMS_OUTPUT = join(DOCS_PUBLIC_ROOT, "llms.txt");

const htmlToMarkdown = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    fences: true,
    resourceLink: true,
  });

function metadataText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ConvertedPage {
  title: string;
  body: string;
}

async function convertHtml(
  html: string,
  fallbackTitle: string
): Promise<ConvertedPage> {
  const $ = load(html);

  // Section headings carry empty self-link anchors (<a href="#id"></a>) that
  // would convert to "[](#id)" artifacts. Drop any fragment link with no text.
  $('a[href^="#"]').each((_, element) => {
    const anchor = $(element);
    if (!anchor.text().trim()) {
      anchor.remove();
    }
  });

  const main = $(".docs-main").first();

  let title = fallbackTitle;
  let subtitle = "";
  let contentHtml: string;

  if (main.length > 0) {
    title = main.find(".docs-title").first().text().trim() || fallbackTitle;
    subtitle = main.find(".docs-subtitle").first().text().trim();
    contentHtml = main.find(".docs-prose").first().html() ?? "";
  } else {
    // Pages outside the DocsContent shell. The rendered HTML is just the
    // page component, so convert it wholesale.
    contentHtml = $.html();
  }

  const file = await htmlToMarkdown.process(contentHtml);
  const markdown = String(file).trim();

  const parts = [`# ${title}`];
  if (subtitle) {
    parts.push(subtitle);
  }
  if (markdown) {
    parts.push(markdown);
  }

  return { title, body: parts.join("\n\n") };
}

function outputPathForRoute(route: string): string {
  return join(OUTPUT_ROOT, `${route.replace(/^\//, "")}.md`);
}

async function main() {
  // Redirect stubs permanently redirect their HTML route; mirroring them
  // would point agents at a page that only says "moved". llms.txt and the
  // mirror tree list the redirect targets instead.
  const pages = discoverDocsPages(DOCS_PAGES_ROOT).filter(
    ({ route }) => !REDIRECT_STUB_ROUTES.has(route)
  );

  await rm(OUTPUT_ROOT, { recursive: true, force: true });

  let written = 0;
  let fallbacks = 0;
  const indexedPages: DocsPageMeta[] = [];

  for (const { pageFile, route } of pages) {
    const rendered = await renderPage(pageFile);
    const metadata = rendered?.metadata ?? (await loadPageMetadata(pageFile));
    const metaTitle = metadataText(metadata?.title);
    const description = metadataText(metadata?.description);

    let converted: ConvertedPage;
    if (rendered) {
      converted = await convertHtml(rendered.html, metaTitle || "Vellum Docs");
    } else if (metaTitle || description) {
      // Page imports but does not render statically. Emit a stub so agents
      // requesting Markdown never get a 404 for a route that serves HTML.
      fallbacks += 1;
      converted = {
        title: metaTitle || "Vellum Docs",
        body: [
          `# ${metaTitle || "Vellum Docs"}`,
          description,
          `This page is not available as Markdown. View it at ${SITE_URL}${route}.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    } else {
      console.warn(`[agent-markdown] Skipping ${route}: no render, no metadata`);
      continue;
    }

    const outputPath = outputPathForRoute(route);
    const markdown = `${converted.body}\n`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, "utf8");
    indexedPages.push({ route, title: converted.title, description });
    written += 1;
  }

  await writeFile(
    DOCS_INDEX_OUTPUT,
    `${JSON.stringify(indexedPages, null, 2)}\n`,
    "utf8"
  );

  await mkdir(dirname(LLMS_OUTPUT), { recursive: true });
  await writeFile(LLMS_OUTPUT, buildLlmsText(indexedPages), "utf8");

  console.log(
    `[agent-markdown] Wrote ${written} Markdown pages (${fallbacks} metadata-only stubs) -> ${OUTPUT_ROOT}`
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : "unknown error";
    console.error(`[agent-markdown] Failed: ${message}`);
    process.exit(1);
  });
