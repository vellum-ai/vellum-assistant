import { load } from "cheerio";

import type { DocsSearchChunk } from "@/lib/docs/search/types";
import { normalizeText, uniqueTokens } from "@/lib/docs/search/text";

export interface ExtractedDocsPage {
  pageTitle: string;
  breadcrumb: string;
  chunks: DocsSearchChunk[];
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

export function extractDocsPageFromHtml(route: string, html: string): ExtractedDocsPage {
  const $ = load(html);
  const main = $(".docs-main").first();

  const pageTitle = normalizeText(main.find("h1").first().text()) || "Docs";
  const breadcrumb = normalizeText(main.find(".docs-breadcrumb").first().text()) || "Docs";

  const proseRoot = main.find(".docs-prose").first();
  const chunks: DocsSearchChunk[] = [];

  const seenIds = new Set<string>();

  proseRoot.find("section[id]").each((_, element) => {
    const section = $(element);
    const sectionId = normalizeText(section.attr("id") ?? "") || null;
    if (!sectionId || seenIds.has(sectionId)) {
      return;
    }

    const headingEl = section.find("h2[id], h3[id]").first();
    const headingText = normalizeText(headingEl.text()) || sectionId;
    const tagName = headingEl.get(0)?.tagName?.toLowerCase();
    const headingLevel: 1 | 2 | 3 = tagName === "h3" ? 3 : 2;
    const body = cleanSectionBody(section.text(), headingText);

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

    const headingText = normalizeText(heading.text()) || sectionId;
    const headingLevel: 1 | 2 | 3 = heading.get(0)?.tagName?.toLowerCase() === "h3" ? 3 : 2;

    const block = heading.closest("section").length > 0 ? heading.closest("section") : heading.parent();
    const body = cleanSectionBody(block.text(), headingText);

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

  const pageBody = normalizeText(proseRoot.text());
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

  return { pageTitle, breadcrumb, chunks };
}
