/**
 * Route handlers for the brain graph visualization endpoint.
 *
 * Queries the memory database to return a knowledge graph shaped for brain-lobe
 * visualization, with memory items mapped to brain regions based on their kind.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { count } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { memoryItems } from "../../memory/schema.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import type { RouteDefinition } from "../http-router.js";

function getMemoryKindColor(kind: string): string {
  switch (kind) {
    case "identity":
      return "#8b5cf6";
    case "preference":
      return "#3b82f6";
    case "project":
      return "#10b981";
    case "decision":
      return "#f59e0b";
    case "constraint":
      return "#ef4444";
    case "event":
      return "#ec4899";
    default:
      return "#94a3b8";
  }
}

export function handleGetBrainGraph(): Response {
  try {
    const db = getDb();

    const kindCountRows = db
      .select({
        kind: memoryItems.kind,
        count: count(),
      })
      .from(memoryItems)
      .groupBy(memoryItems.kind)
      .all();

    const memorySummary = kindCountRows.map((row) => ({
      kind: row.kind,
      count: row.count,
      color: getMemoryKindColor(row.kind),
    }));

    const totalKnowledgeCount = memorySummary.reduce(
      (sum, entry) => sum + entry.count,
      0,
    );

    return Response.json({
      entities: [],
      relations: [],
      memorySummary,
      totalKnowledgeCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      {
        error: "Failed to generate brain graph",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export function handleServeBrainGraphUI(bearerToken?: string): Response {
  try {
    const brainGraphDir = resolveBundledDir(
      import.meta.dirname ?? __dirname,
      "./brain-graph",
      "brain-graph",
    );
    let html = readFileSync(join(brainGraphDir, "brain-graph.html"), "utf-8");
    if (bearerToken) {
      // Inject token as a meta tag for client-side fetch authentication.
      // HTML-escape the token value to guard against injection if the token
      // comes from an environment variable with special characters.
      const escapedToken = bearerToken
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      html = html.replace(
        "</head>",
        `  <meta name="api-token" content="${escapedToken}">\n</head>`,
      );
    }
    // CSP permits the CDN sources required by D3.js and Three.js.
    // 'unsafe-eval' is needed by Three.js's shader compilation path.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://d3js.org",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data:",
    ].join("; ");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp,
      },
    });
  } catch (err) {
    return Response.json(
      {
        error: "Brain graph UI not available",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function brainGraphRouteDefinitions(deps: {
  mintUiPageToken: () => string;
}): RouteDefinition[] {
  return [
    {
      endpoint: "brain-graph",
      method: "GET",
      handler: () => handleGetBrainGraph(),
    },
    {
      endpoint: "brain-graph-ui",
      method: "GET",
      handler: () => handleServeBrainGraphUI(deps.mintUiPageToken()),
    },
  ];
}
