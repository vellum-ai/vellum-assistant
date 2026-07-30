import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { Metadata } from "next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

export function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

export function isPrivateSegment(segment: string): boolean {
  return segment.startsWith("_");
}

/** Recursively list page.tsx files under a Next app directory, skipping
 *  private (underscore-prefixed) folders like _components. */
export async function listPageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isPrivateSegment(entry.name)) {
        continue;
      }
      const nested = await listPageFiles(absolute);
      results.push(...nested);
      continue;
    }

    if (entry.isFile() && entry.name === "page.tsx") {
      results.push(absolute);
    }
  }

  return results;
}

/** Derive the URL route for a page file relative to a pages root, stripping
 *  route-group segments (parenthesized folders do not affect the URL). */
export function routeFromPageFile(
  pageFile: string,
  pagesRoot: string,
  baseRoute: string
): string {
  const relativeDir = relative(pagesRoot, dirname(pageFile));
  if (!relativeDir || relativeDir === ".") {
    return baseRoute;
  }

  const segments = relativeDir
    .split(sep)
    .filter((segment) => segment.length > 0 && !isRouteGroupSegment(segment));

  if (segments.length === 0) {
    return baseRoute;
  }

  return `${baseRoute}/${segments.join("/")}`;
}

export interface RenderedPage {
  html: string;
  metadata: Metadata | undefined;
}

/** Import a page module and return its exported metadata without rendering.
 *  Useful as a fallback for pages that import cleanly but fail to render
 *  (e.g. components that suspend during static rendering). */
export async function loadPageMetadata(pageFile: string): Promise<Metadata | undefined> {
  try {
    const pageModule = await import(pathToFileURL(pageFile).href);
    return pageModule.metadata as Metadata | undefined;
  } catch {
    return undefined;
  }
}

/** Import a page module and render its default export to static HTML.
 *  Returns null for pages that redirect or fail to render. Only the page
 *  component is rendered; layouts (nav, header, footer) are not included. */
export async function renderPage(pageFile: string): Promise<RenderedPage | null> {
  try {
    const pageModule = await import(pathToFileURL(pageFile).href);
    const Page = pageModule.default as React.ComponentType;

    if (!Page) {
      return null;
    }

    return {
      html: renderToStaticMarkup(React.createElement(Page)),
      metadata: pageModule.metadata as Metadata | undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown render error";
    if (message.includes("NEXT_REDIRECT")) {
      return null;
    }
    console.warn(`[docs-pages] Failed to render ${pageFile}: ${message}`);
    return null;
  }
}
