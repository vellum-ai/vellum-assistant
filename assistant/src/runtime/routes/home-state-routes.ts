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

import { RelationshipStateSchema } from "../../api/responses/home.js";
import {
  computeRelationshipState,
  getRelationshipStatePath,
} from "../../home/relationship-state-writer.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("home-state-routes");

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle `GET /v1/home/state`.
 *
 * Always computes a fresh snapshot so the response reflects the
 * latest OAuth connection state, conversation count, and extracted
 * facts — not just whatever the conversation-complete writer last
 * persisted. This avoids serving stale capability tiers when the
 * user connects an integration between turns, or when a delete/wipe
 * flow mutates conversation count outside the turn-boundary writer.
 *
 * The persisted `relationship-state.json` remains useful as:
 *   - A seed for the existing-user backfill on daemon startup.
 *   - A fallback when live compute fails (e.g. DB not yet ready at
 *     cold start, or a transient filesystem error).
 *
 * The route does NOT write to disk or emit SSE on read — writes are
 * still owned exclusively by the writer so turn-boundary SSE events
 * remain tied to real state transitions rather than GET traffic.
 */
async function handleGetHomeState(): Promise<unknown> {
  try {
    return await computeRelationshipState();
  } catch (computeErr) {
    log.warn(
      { err: computeErr },
      "Live compute failed; falling back to persisted relationship-state.json",
    );
  }

  const path = getRelationshipStatePath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const validated = RelationshipStateSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
      log.warn(
        { path, issues: validated.error.issues },
        "Persisted relationship-state.json failed schema validation",
      );
    } catch (err) {
      log.warn(
        { err, path },
        "Failed to read persisted relationship-state.json as fallback",
      );
    }
  }

  throw new InternalError("Failed to compute relationship state");
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "home_state_get",
    endpoint: "home/state",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetHomeState,
    summary: "Get relationship state",
    description:
      "Return the current `RelationshipState` snapshot. Reads the persisted `relationship-state.json` when present; falls back to an on-demand compute so fresh installs never see a 404.",
    tags: ["home"],
    responseBody: RelationshipStateSchema,
    additionalResponses: {
      "500": {
        description: "Failed to compute relationship state",
      },
    },
  },
];
