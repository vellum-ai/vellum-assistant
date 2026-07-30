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

export async function loadPageModule(pageFile: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(pageFile).href)) as Record<string, unknown>;
}

/** Import a page module and return its exported metadata without rendering.
 *  Used for pages that cannot be statically rendered (request-time pages and
 *  redirect stubs) so generators can still emit metadata-only entries. */
export async function loadPageMetadata(pageFile: string): Promise<Metadata | undefined> {
  try {
    const pageModule = await loadPageModule(pageFile);
    return pageModule.metadata as Metadata | undefined;
  } catch {
    return undefined;
  }
}

function isRedirectError(error: unknown): boolean {
  const digest = (error as { digest?: unknown })?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
    return true;
  }
  return error instanceof Error && error.message.includes("NEXT_REDIRECT");
}

// Request-time pages suspend during static rendering: React either throws a
// thenable or reports the suspension as a synchronous-input error.
function isSuspenseSignal(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { then?: unknown }).then === "function"
  ) {
    return true;
  }
  return error instanceof Error && error.message.includes("A component suspended");
}

/** Import a page module and render its default export to static HTML.
 *  Returns null for pages that redirect, suspend (request-time content), or
 *  lack a default export; any other render failure propagates to the caller.
 *  Only the page component is rendered: layouts (nav, header, footer) are not
 *  included. */
export async function renderPage(pageFile: string): Promise<RenderedPage | null> {
  const pageModule = await loadPageModule(pageFile);
  const Page = pageModule.default as React.ComponentType | undefined;

  if (!Page) {
    return null;
  }

  try {
    return {
      html: renderToStaticMarkup(React.createElement(Page)),
      metadata: pageModule.metadata as Metadata | undefined,
    };
  } catch (error) {
    if (isRedirectError(error) || isSuspenseSignal(error)) {
      return null;
    }
    throw error;
  }
}
