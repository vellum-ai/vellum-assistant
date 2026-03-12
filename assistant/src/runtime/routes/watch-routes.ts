/**
 * HTTP route handler for watch (ambient observation) functionality.
 *
 * Decoupled from computer-use routes so that the watch endpoint has
 * zero dependency on CU session state.
 */

import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("watch-routes");

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for watch observation handling.
 * The daemon wires a concrete implementation at startup.
 */
export interface WatchDeps {
  /** Handle a watch observation. */
  handleWatchObservation: (params: {
    watchId: string;
    sessionId: string;
    ocrText: string;
    appName?: string;
    windowTitle?: string;
    bundleIdentifier?: string;
    timestamp: number;
    captureIndex: number;
    totalExpected: number;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /v1/computer-use/watch — send a watch observation.
 *
 * Body: { watchId, sessionId, ocrText, appName?, windowTitle?,
 *         bundleIdentifier?, timestamp, captureIndex, totalExpected }
 */
async function handleWatchObservationRoute(
  req: Request,
  deps: WatchDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    watchId?: string;
    sessionId?: string;
    ocrText?: string;
    appName?: string;
    windowTitle?: string;
    bundleIdentifier?: string;
    timestamp?: number;
    captureIndex?: number;
    totalExpected?: number;
  };

  if (!body.watchId || typeof body.watchId !== "string") {
    return httpError("BAD_REQUEST", "watchId is required", 400);
  }
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return httpError("BAD_REQUEST", "sessionId is required", 400);
  }
  if (!body.ocrText || typeof body.ocrText !== "string") {
    return httpError("BAD_REQUEST", "ocrText is required", 400);
  }
  if (typeof body.timestamp !== "number") {
    return httpError("BAD_REQUEST", "timestamp is required", 400);
  }
  if (typeof body.captureIndex !== "number") {
    return httpError("BAD_REQUEST", "captureIndex is required", 400);
  }
  if (typeof body.totalExpected !== "number") {
    return httpError("BAD_REQUEST", "totalExpected is required", 400);
  }

  try {
    await deps.handleWatchObservation({
      watchId: body.watchId,
      sessionId: body.sessionId,
      ocrText: body.ocrText,
      appName: body.appName,
      windowTitle: body.windowTitle,
      bundleIdentifier: body.bundleIdentifier,
      timestamp: body.timestamp,
      captureIndex: body.captureIndex,
      totalExpected: body.totalExpected,
    });

    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, watchId: body.watchId },
      "Failed to handle watch observation via HTTP",
    );
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function watchRouteDefinitions(deps: {
  getWatchDeps?: () => WatchDeps;
}): RouteDefinition[] {
  const getDeps = (): WatchDeps => {
    if (!deps.getWatchDeps) {
      throw new Error("Watch deps not available");
    }
    return deps.getWatchDeps();
  };

  return [
    {
      endpoint: "computer-use/watch",
      method: "POST",
      policyKey: "computer-use/watch",
      handler: async ({ req }) => handleWatchObservationRoute(req, getDeps()),
    },
  ];
}
