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
import { mkdir, opendir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "cheerio";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { agentMarkdownPathForPage } from "../src/lib/agent-markdown-paths";
import { SITE_URL } from "../src/lib/metadata";
import {
  listPageFiles,
  loadPageMetadata,
  renderPage,
  routeFromPageFile,
} from "./lib/docs-pages";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_PAGES_ROOT = join(ROOT, "src", "app", "docs");
const OUTPUT_ROOT = join(ROOT, "generated", "md");
const DOCS_INDEX_OUTPUT = join(OUTPUT_ROOT, "docs-index.json");
const DOCS_PUBLIC_ROOT = join(ROOT, "public", "docs");
const LLMS_OUTPUT = join(DOCS_PUBLIC_ROOT, "llms.txt");

/** Title/description for a docs page, emitted to the sidecar metadata index
 *  so llms.txt lists exactly what the mirrors serve without parsing the .md
 *  bodies. */
interface DocsPageMeta {
  route: string;
  title: string;
  description: string;
}

/** The /docs/api subtree is reserved for non-page surfaces and is excluded
 *  from mirroring (the Accept rewrites in next.config.ts skip it too). */
function isMirroredRoute(route: string): boolean {
  return route !== "/docs/api" && !route.startsWith("/docs/api/");
}

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

async function removeGeneratedDocsLlmsFiles(dir: string): Promise<void> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeGeneratedDocsLlmsFiles(path);
    } else if (entry.isFile() && entry.name === "llms.txt") {
      await rm(path, { force: true });
    }
  }
}

/** Public markdown URL for a docs route (the `.md`-suffix form advertised to
 *  agents; the Accept-negotiation rewrite serves the same bytes). */
function markdownUrl(route: string): string {
  const path = agentMarkdownPathForPage(route);
  if (!path) {
    throw new Error(`No markdown alternate path for docs route ${route}`);
  }
  return `${SITE_URL}${path}`;
}

function buildLlmsText(pages: DocsPageMeta[]): string {
  const lines = [
    "# Vellum Docs",
    "",
    "> Vellum is a personal AI assistant that remembers, learns, and takes real action across your apps, files, and communication channels.",
    "",
    "Vellum runs in Vellum Cloud by default, can run locally or on your own infrastructure, and ships as open-source software. These docs cover setup, memory, channels, skills, tools, hosting, security, and developer workflows.",
    "",
    "Install: `curl -fsSL https://www.vellum.ai/install.sh | bash && . ~/.config/vellum/env`",
    "",
    "Repo: https://github.com/vellum-ai/vellum-assistant",
    "",
    `Docs: ${SITE_URL}/docs`,
    "",
    `Full LLM index: ${SITE_URL}/llms.txt`,
    "",
    `Every page below is served as Markdown at its canonical URL with a \`.md\` suffix (e.g. ${SITE_URL}/docs/getting-started.md) or by sending an \`Accept: text/markdown\` header.`,
    "",
    "## Docs",
    "",
  ];

  const sorted = [...pages].sort((a, b) => a.route.localeCompare(b.route));
  for (const page of sorted) {
    const description = page.description ? `: ${page.description}` : "";
    lines.push(`- [${page.title}](${markdownUrl(page.route)})${description}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function main() {
  const pageFiles = (await listPageFiles(DOCS_PAGES_ROOT)).sort();
  const pages = pageFiles
    .map((pageFile) => ({
      pageFile,
      route: routeFromPageFile(pageFile, DOCS_PAGES_ROOT, "/docs"),
    }))
    .filter(({ route }) => isMirroredRoute(route));

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await removeGeneratedDocsLlmsFiles(DOCS_PUBLIC_ROOT);

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
