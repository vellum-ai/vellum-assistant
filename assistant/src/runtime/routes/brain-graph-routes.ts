/**
 * Route handlers for the brain graph visualization endpoint.
 *
 * Queries the memory database to return a knowledge graph shaped for brain-lobe
 * visualization, with memory items mapped to brain regions based on their type.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { count } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db.js";
import { memoryGraphNodes } from "../../memory/schema.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import type { RouteDefinition } from "../http-router.js";

function getMemoryKindColor(kind: string): string {
  switch (kind) {
    case "episodic":
      return "#ec4899"; // pink — specific moments/events
    case "semantic":
      return "#3b82f6"; // blue — facts/knowledge
    case "procedural":
      return "#10b981"; // green — skills/how-to
    case "emotional":
      return "#ef4444"; // red — feelings
    case "prospective":
      return "#f59e0b"; // amber — future-oriented
    case "behavioral":
      return "#8b5cf6"; // violet — behavioral patterns
    case "narrative":
      return "#6366f1"; // indigo — stories
    case "shared":
      return "#14b8a6"; // teal — relationship memories
    default:
      return "#94a3b8";
  }
}

function handleGetBrainGraph(): Response {
  try {
    const db = getDb();

    const kindCountRows = db
      .select({
        kind: memoryGraphNodes.type,
        count: count(),
      })
      .from(memoryGraphNodes)
      .groupBy(memoryGraphNodes.type)
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
      summary: "Get brain graph data",
      description:
        "Return a knowledge-graph shaped for brain-lobe visualization, with memory items mapped to brain regions.",
      tags: ["brain-graph"],
      responseBody: z.object({
        entities: z.array(z.unknown()).describe("Graph entity nodes"),
        relations: z.array(z.unknown()).describe("Graph relation edges"),
        memorySummary: z
          .array(z.unknown())
          .describe("Memory kind counts and colors"),
        totalKnowledgeCount: z.number().int(),
        generatedAt: z.string().describe("ISO 8601 timestamp"),
      }),
      handler: () => handleGetBrainGraph(),
    },
    {
      endpoint: "brain-graph-ui",
      method: "GET",
      summary: "Serve brain graph UI",
      description:
        "Return the brain-graph HTML visualization page with an embedded auth token.",
      tags: ["brain-graph"],
      handler: () => handleServeBrainGraphUI(deps.mintUiPageToken()),
    },
  ];
}
