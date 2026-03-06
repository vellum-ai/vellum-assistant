/**
 * Route handlers for the brain graph visualization endpoint.
 *
 * Queries the memory database to return a knowledge graph shaped for brain-lobe
 * visualization, with entities mapped to brain regions based on their type.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { count } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import {
  memoryEntities,
  memoryEntityRelations,
  memoryItems,
} from "../../memory/schema.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import type { RouteDefinition } from "../http-router.js";

function getLobeRegion(entityType: string): string {
  switch (entityType) {
    case "person":
    case "organization":
      return "right-social";
    case "project":
    case "company":
      return "left-planning";
    case "tool":
      return "left-technical";
    case "concept":
      return "right-creative";
    case "location":
      return "right-spatial";
    default:
      return "center";
  }
}

function getEntityColor(entityType: string): string {
  switch (entityType) {
    case "person":
      return "#22c55e";
    case "project":
      return "#f97316";
    case "tool":
      return "#06b6d4";
    case "company":
      return "#a855f7";
    case "organization":
      return "#a855f7";
    case "concept":
      return "#eab308";
    case "location":
      return "#14b8a6";
    default:
      return "#94a3b8";
  }
}

function getMemoryKindColor(kind: string): string {
  switch (kind) {
    case "profile":
      return "#8b5cf6";
    case "preference":
      return "#3b82f6";
    case "constraint":
      return "#ef4444";
    case "instruction":
      return "#f59e0b";
    case "style":
      return "#ec4899";
    default:
      return "#94a3b8";
  }
}

export function handleGetBrainGraph(): Response {
  try {
    const db = getDb();

    const entityRows = db
      .select({
        id: memoryEntities.id,
        name: memoryEntities.name,
        type: memoryEntities.type,
        mentionCount: memoryEntities.mentionCount,
        firstSeenAt: memoryEntities.firstSeenAt,
        lastSeenAt: memoryEntities.lastSeenAt,
      })
      .from(memoryEntities)
      .all();

    const relationRows = db
      .select({
        sourceEntityId: memoryEntityRelations.sourceEntityId,
        targetEntityId: memoryEntityRelations.targetEntityId,
        relation: memoryEntityRelations.relation,
      })
      .from(memoryEntityRelations)
      .all();

    const kindCountRows = db
      .select({
        kind: memoryItems.kind,
        count: count(),
      })
      .from(memoryItems)
      .groupBy(memoryItems.kind)
      .all();

    const entities = entityRows.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      lobeRegion: getLobeRegion(entity.type),
      color: getEntityColor(entity.type),
      mentionCount: entity.mentionCount,
      firstSeenAt: entity.firstSeenAt,
      lastSeenAt: entity.lastSeenAt,
    }));

    const relations = relationRows.map((rel) => ({
      sourceId: rel.sourceEntityId,
      targetId: rel.targetEntityId,
      relation: rel.relation,
    }));

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
      entities,
      relations,
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

export function handleServeHomeBaseUI(bearerToken?: string): Response {
  try {
    const prebuiltDir = resolveBundledDir(
      import.meta.dirname ?? __dirname,
      "../../home-base/prebuilt",
      "prebuilt",
    );
    let html = readFileSync(join(prebuiltDir, "index.html"), "utf-8");
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
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    return Response.json(
      {
        error: "Home Base UI not available",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export function handleServeBrainGraphUI(bearerToken?: string): Response {
  try {
    const prebuiltDir = resolveBundledDir(
      import.meta.dirname ?? __dirname,
      "../../home-base/prebuilt",
      "prebuilt",
    );
    let html = readFileSync(join(prebuiltDir, "brain-graph.html"), "utf-8");
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
    {
      endpoint: "home-base-ui",
      method: "GET",
      handler: () => handleServeHomeBaseUI(deps.mintUiPageToken()),
    },
  ];
}
