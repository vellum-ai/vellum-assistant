import { load, type Cheerio, type CheerioAPI } from "cheerio";

import type { DocsSearchChunk } from "@/lib/docs/search/types";
import { normalizeText, uniqueTokens } from "@/lib/docs/search/text";

// Cheerio<AnyNode> derived without importing domhandler, which is not a direct dependency.
type NodeSelection = ReturnType<Cheerio<never>["contents"]>;

// Cheerio's .text() concatenates adjacent elements without separators, fusing tokens
// like <li>Alpha</li><li>Beta</li> into "AlphaBeta". Insert element boundaries as spaces
// on a detached clone so extracted text keeps one token per word.
function elementText($: CheerioAPI, selection: NodeSelection): string {
  const parts: string[] = [];

  selection.each((_, node) => {
    const clone = $(node).clone();
    clone.find("*").each((_, descendant) => {
      $(descendant).before(" ").after(" ");
    });
    parts.push(clone.text());
  });

  return normalizeText(parts.join(" "));
}

function cleanSectionBody(sectionText: string, headingText: string): string {
  const normalizedSection = normalizeText(sectionText);
  if (!headingText) {
    return normalizedSection;
  }

  if (normalizedSection.toLowerCase().startsWith(headingText.toLowerCase())) {
    return normalizeText(normalizedSection.slice(headingText.length));
  }

  return normalizedSection;
}

function buildKeywords(route: string, breadcrumb: string, pageTitle: string, heading: string, sectionId: string | null): string[] {
  const routeTokens = route
    .replace(/^\/docs\/?/, "")
    .split("/")
    .flatMap((segment) => segment.split("-"));

  return uniqueTokens([
    ...routeTokens,
    breadcrumb,
    pageTitle,
    heading,
    sectionId ?? "",
  ]);
}

function makeChunk(params: {
  route: string;
  pageTitle: string;
  breadcrumb: string;
  heading: string;
  headingLevel: 1 | 2 | 3;
  sectionId: string | null;
  body: string;
}): DocsSearchChunk {
  const url = params.sectionId ? `${params.route}#${params.sectionId}` : params.route;
  const id = params.sectionId ? `${params.route}#${params.sectionId}` : `${params.route}#__page`;

  return {
    id,
    route: params.route,
    url,
    pageTitle: params.pageTitle,
    breadcrumb: params.breadcrumb,
    heading: params.heading,
    headingLevel: params.headingLevel,
    sectionId: params.sectionId,
    body: params.body,
    keywords: buildKeywords(
      params.route,
      params.breadcrumb,
      params.pageTitle,
      params.heading,
      params.sectionId
    ),
  };
}

export function extractDocsPageFromHtml(route: string, html: string): DocsSearchChunk[] {
  const $ = load(html);
  const main = $(".docs-main").first();

  const pageTitle = elementText($, main.find("h1").first()) || "Docs";
  const breadcrumb = elementText($, main.find(".docs-breadcrumb").first()) || "Docs";

  const proseRoot = main.find(".docs-prose").first();
  const chunks: DocsSearchChunk[] = [];

  const seenIds = new Set<string>();

  proseRoot.find("section[id]").each((_, element) => {
    const section = $(element);
    const sectionId = normalizeText(section.attr("id") ?? "") || null;
    if (!sectionId || seenIds.has(sectionId)) {
      return;
    }

    const headingEl = section.find("h2, h3").first();
    const headingText = elementText($, headingEl) || sectionId;
    const tagName = headingEl.get(0)?.tagName?.toLowerCase();
    const headingLevel: 1 | 2 | 3 = tagName === "h3" ? 3 : 2;
    const body = cleanSectionBody(elementText($, section), headingText);

    if (!body) {
      return;
    }

    chunks.push(
      makeChunk({
        route,
        pageTitle,
        breadcrumb,
        heading: headingText,
        headingLevel,
        sectionId,
        body,
      })
    );

    seenIds.add(sectionId);
  });

  proseRoot.find("h2[id], h3[id]").each((_, element) => {
    const heading = $(element);
    const sectionId = normalizeText(heading.attr("id") ?? "") || null;
    if (!sectionId || seenIds.has(sectionId)) {
      return;
    }

    const headingText = elementText($, heading) || sectionId;
    const headingLevel: 1 | 2 | 3 = heading.get(0)?.tagName?.toLowerCase() === "h3" ? 3 : 2;

    const parentSection = heading.closest("section");
    // Stop only at same-or-higher-level headings so an h2 block keeps its
    // child h3 content instead of ending at the first subsection heading.
    const stopSelector = headingLevel === 3 ? "h1, h2, h3, section" : "h1, h2, section";
    const block =
      parentSection.length > 0
        ? parentSection
        : heading.add(heading.nextUntil(stopSelector));
    const body = cleanSectionBody(elementText($, block), headingText);

    if (!body) {
      return;
    }

    chunks.push(
      makeChunk({
        route,
        pageTitle,
        breadcrumb,
        heading: headingText,
        headingLevel,
        sectionId,
        body,
      })
    );

    seenIds.add(sectionId);
  });

  const pageBody = elementText($, proseRoot);
  if (pageBody) {
    chunks.unshift(
      makeChunk({
        route,
        pageTitle,
        breadcrumb,
        heading: pageTitle,
        headingLevel: 1,
        sectionId: null,
        body: pageBody,
      })
    );
  }

  return chunks;
}
