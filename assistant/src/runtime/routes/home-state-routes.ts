/**
 * Home state HTTP routes.
 *
 * Exposes `GET /v1/home/state` so macOS (and other) clients can fetch
 * the current `RelationshipState` snapshot. The normal path reads
 * the JSON file produced by `writeRelationshipState()`; if that file
 * is missing — e.g. on a fresh install before the writer has landed
 * its first snapshot — the handler falls back to computing the
 * state on-demand so the client never sees a 404 and the UI can
 * always render.
 */

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import {
  computeRelationshipState,
  getRelationshipStatePath,
} from "../../home/relationship-state-writer.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("home-state-routes");

// ---------------------------------------------------------------------------
// Response schema (shared with the OpenAPI generator and runtime validation)
// ---------------------------------------------------------------------------

const factSchema = z.object({
  id: z.string(),
  category: z.enum(["voice", "world", "priorities"]),
  text: z.string(),
  confidence: z.enum(["strong", "uncertain"]),
  source: z.enum(["onboarding", "inferred"]),
});

const capabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tier: z.enum(["unlocked", "next-up", "earned"]),
  gate: z.string(),
  unlockHint: z.string().optional(),
  ctaLabel: z.string().optional(),
});

const relationshipStateSchema = z.object({
  version: z.literal(1),
  assistantId: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  progressPercent: z.number(),
  facts: z.array(factSchema),
  capabilities: z.array(capabilitySchema),
  conversationCount: z.number(),
  hatchedDate: z.string(),
  assistantName: z.string(),
  userName: z.string().optional(),
  updatedAt: z.string(),
});

/**
 * Handle `GET /v1/home/state`.
 *
 * Returns the persisted `relationship-state.json` when present; on a
 * cache miss (missing file, unreadable JSON, OR structurally-invalid
 * shape) falls back to `computeRelationshipState()` so callers always
 * get a valid response shape that matches `relationshipStateSchema`.
 * The read-through fallback deliberately does NOT write a fresh
 * snapshot to disk — the daemon's conversation-complete hook owns
 * writes so progress updates stay batched to real state transitions
 * rather than opportunistic GETs.
 */
export async function handleGetHomeState(): Promise<Response> {
  const path = getRelationshipStatePath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      // Validate shape, not just JSON syntax. A stale or partial file
      // (e.g. from a pre-v1 snapshot or a truncated write) must NOT be
      // served to the client — fall through to compute instead so
      // strict client decoders don't choke.
      const validated = relationshipStateSchema.safeParse(parsed);
      if (validated.success) {
        return Response.json(validated.data);
      }
      log.warn(
        { path, issues: validated.error.issues },
        "Persisted relationship-state.json failed schema validation; falling back to live compute",
      );
    } catch (err) {
      log.warn(
        { err, path },
        "Failed to read persisted relationship-state.json; falling back to live compute",
      );
      // Fall through to the compute path.
    }
  }

  try {
    const state = await computeRelationshipState();
    return Response.json(state);
  } catch (err) {
    log.warn({ err }, "Failed to compute relationship state on-demand");
    return httpError(
      "INTERNAL_ERROR",
      "Failed to compute relationship state",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function homeStateRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "home/state",
      method: "GET",
      handler: () => handleGetHomeState(),
      summary: "Get relationship state",
      description:
        "Return the current `RelationshipState` snapshot. Reads the persisted `relationship-state.json` when present; falls back to an on-demand compute so fresh installs never see a 404.",
      tags: ["home"],
      responseBody: relationshipStateSchema,
    },
  ];
}
