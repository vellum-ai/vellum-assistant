/**
 * HTTP route handlers for computer use session lifecycle.
 *
 * These endpoints expose CU session management, ride-shotgun, and watch
 * observation functionality over HTTP. The existing IPC handlers remain
 * as the primary transport; these routes provide the HTTP-first API
 * surface for the phase-out-ipc migration.
 *
 * All CU write operations require the `chat.write` scope.
 */

import { getConfig } from "../../config/loader.js";
import type { ComputerUseSession } from "../../daemon/computer-use-session.js";
import type { CuObservation } from "../../daemon/message-protocol.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { RateLimitProvider } from "../../providers/ratelimit.js";
import { getFailoverProvider } from "../../providers/registry.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("computer-use-routes");

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for CU session management.
 * The daemon wires a concrete implementation at startup.
 */
export interface ComputerUseDeps {
  /** Active CU sessions keyed by session ID. */
  cuSessions: Map<string, ComputerUseSession>;
  /** Shared rate-limiter timestamps across the daemon. */
  sharedRequestTimestamps: number[];
  /** Sequence tracker for CU observations (per session). */
  cuObservationParseSequence: Map<string, number>;
  /** Handle a ride-shotgun start request. Returns watchId and sessionId. */
  handleRideShotgunStart: (params: {
    durationSeconds: number;
    intervalSeconds: number;
    mode?: "observe" | "learn";
    targetDomain?: string;
    navigateDomain?: string;
    autoNavigate?: boolean;
  }) => Promise<{ watchId: string; sessionId: string }>;
  /** Handle a ride-shotgun stop request. */
  handleRideShotgunStop: (watchId: string) => Promise<void>;
  /** Get ride-shotgun session status by watchId. */
  getRideShotgunStatus: (watchId: string) => {
    status: "active" | "completing" | "completed" | "cancelled";
    sessionId: string;
    recordingId?: string;
    savedRecordingPath?: string;
    bootstrapFailureReason?: string;
  } | undefined;
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
// Helpers
// ---------------------------------------------------------------------------

/** Publish a server message to the SSE event hub for HTTP clients. */
function publishEvent(msg: ServerMessage, sessionId?: string): void {
  void assistantEventHub.publish(
    buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, msg, sessionId),
  );
}

function removeCuSessionReferences(
  deps: ComputerUseDeps,
  sessionId: string,
  expectedSession?: ComputerUseSession,
): void {
  const current = deps.cuSessions.get(sessionId);
  if (expectedSession && current && current !== expectedSession) {
    return;
  }
  deps.cuSessions.delete(sessionId);
  deps.cuObservationParseSequence.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/computer-use/sessions — create a CU session.
 *
 * Body: { sessionId, task, screenWidth, screenHeight, interactionType? }
 */
async function handleCreateSession(
  req: Request,
  deps: ComputerUseDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    sessionId?: string;
    task?: string;
    screenWidth?: number;
    screenHeight?: number;
    interactionType?: "computer_use" | "text_qa";
  };

  const { sessionId, task, screenWidth, screenHeight, interactionType } = body;

  if (!sessionId || typeof sessionId !== "string") {
    return httpError("BAD_REQUEST", "sessionId is required", 400);
  }
  if (!task || typeof task !== "string") {
    return httpError("BAD_REQUEST", "task is required", 400);
  }
  if (typeof screenWidth !== "number" || screenWidth <= 0) {
    return httpError("BAD_REQUEST", "screenWidth must be a positive number", 400);
  }
  if (typeof screenHeight !== "number" || screenHeight <= 0) {
    return httpError("BAD_REQUEST", "screenHeight must be a positive number", 400);
  }

  // Abort any existing session with the same ID to prevent zombies
  const existingSession = deps.cuSessions.get(sessionId);
  if (existingSession) {
    existingSession.abort();
    removeCuSessionReferences(deps, sessionId, existingSession);
  }

  const config = getConfig();
  let provider = getFailoverProvider(config.provider, config.providerOrder);
  const { rateLimit } = config;
  if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
    provider = new RateLimitProvider(
      provider,
      rateLimit,
      deps.sharedRequestTimestamps,
    );
  }

  const sendToClient = (serverMsg: ServerMessage) => {
    publishEvent(serverMsg, sessionId);
  };

  const sessionRef: { current?: ComputerUseSession } = {};
  const onTerminal = (sid: string) => {
    removeCuSessionReferences(deps, sid, sessionRef.current);
    log.info({ sessionId: sid }, "Computer-use session cleaned up after terminal state");
  };

  // Dynamic import to avoid circular dependency
  const { ComputerUseSession: CUSession } = await import(
    "../../daemon/computer-use-session.js"
  );

  const session = new CUSession(
    sessionId,
    task,
    screenWidth,
    screenHeight,
    provider,
    sendToClient,
    interactionType,
    onTerminal,
  );
  sessionRef.current = session;

  deps.cuSessions.set(sessionId, session);

  log.info(
    { sessionId, taskLength: task.length },
    "Computer-use session created via HTTP",
  );

  return Response.json({ sessionId }, { status: 201 });
}

/**
 * POST /v1/computer-use/sessions/:id/abort — abort a CU session.
 */
function handleAbortSession(
  sessionId: string,
  deps: ComputerUseDeps,
): Response {
  const session = deps.cuSessions.get(sessionId);
  if (!session) {
    log.debug(
      { sessionId },
      "CU session abort via HTTP: session not found (already finished?)",
    );
    return httpError("NOT_FOUND", "Session not found", 404);
  }

  session.abort();
  removeCuSessionReferences(deps, sessionId, session);

  log.info({ sessionId }, "Computer-use session aborted via HTTP");
  return Response.json({ ok: true });
}

/**
 * POST /v1/computer-use/observations — send a CU observation.
 *
 * Body: { sessionId, axTree?, axDiff?, secondaryWindows?, screenshot?,
 *         screenshotWidthPx?, screenshotHeightPx?, screenWidthPt?,
 *         screenHeightPt?, coordinateOrigin?, captureDisplayId?,
 *         executionResult?, executionError?, userGuidance? }
 */
async function handleObservation(
  req: Request,
  deps: ComputerUseDeps,
): Promise<Response> {
  const receiveTimestampMs = Date.now();
  const msg = (await req.json()) as CuObservation;

  if (!msg.sessionId || typeof msg.sessionId !== "string") {
    return httpError("BAD_REQUEST", "sessionId is required", 400);
  }

  // HTTP observations arrive with inline data (no blob refs to hydrate).
  // Use the shared deps-injected sequence map as the single source of truth.
  const previousSequence =
    deps.cuObservationParseSequence.get(msg.sessionId) ?? 0;
  const sequence = previousSequence + 1;
  deps.cuObservationParseSequence.set(msg.sessionId, sequence);

  const axTreeBytes = msg.axTree ? Buffer.byteLength(msg.axTree, "utf8") : 0;
  const axDiffBytes = msg.axDiff ? Buffer.byteLength(msg.axDiff, "utf8") : 0;
  const secondaryWindowsBytes = msg.secondaryWindows
    ? Buffer.byteLength(msg.secondaryWindows, "utf8")
    : 0;
  const screenshotBase64Bytes = msg.screenshot
    ? Buffer.byteLength(msg.screenshot, "utf8")
    : 0;
  const screenshotApproxRawBytes = msg.screenshot
    ? Math.floor((msg.screenshot.length / 4) * 3)
    : 0;

  log.info(
    {
      sessionId: msg.sessionId,
      sequence,
      receiveTimestampMs,
      axTreeBytes,
      axDiffBytes,
      secondaryWindowsBytes,
      screenshotBase64Bytes,
      screenshotApproxRawBytes,
    },
    "HTTP_METRIC cu_observation_http_receive",
  );

  const session = deps.cuSessions.get(msg.sessionId);
  if (!session) {
    publishEvent(
      {
        type: "cu_error",
        sessionId: msg.sessionId,
        message: `No computer-use session found for id ${msg.sessionId}`,
      },
      msg.sessionId,
    );
    return httpError(
      "NOT_FOUND",
      `No computer-use session found for id ${msg.sessionId}`,
      404,
    );
  }

  // Fire-and-forget: the session sends messages via its sendToClient callback
  session.handleObservation(msg).catch((err) => {
    log.error(
      { err, sessionId: msg.sessionId },
      "Error handling CU observation (HTTP)",
    );
  });

  return Response.json({ ok: true, sequence });
}

/**
 * POST /v1/computer-use/tasks — submit a task.
 *
 * This is a simplified HTTP version of task_submit that creates a CU session.
 * The full task_submit flow (with routing, recording intents, etc.) remains
 * IPC-only for now; this endpoint provides direct CU session creation.
 *
 * Body: { task, screenWidth, screenHeight, interactionType? }
 */
async function handleTaskSubmit(
  req: Request,
  deps: ComputerUseDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    task?: string;
    screenWidth?: number;
    screenHeight?: number;
    interactionType?: "computer_use" | "text_qa";
  };

  const { task, screenWidth, screenHeight, interactionType } = body;

  if (!task || typeof task !== "string") {
    return httpError("BAD_REQUEST", "task is required", 400);
  }
  if (typeof screenWidth !== "number" || screenWidth <= 0) {
    return httpError("BAD_REQUEST", "screenWidth must be a positive number", 400);
  }
  if (typeof screenHeight !== "number" || screenHeight <= 0) {
    return httpError("BAD_REQUEST", "screenHeight must be a positive number", 400);
  }

  const sessionId = crypto.randomUUID();

  // Reuse session creation logic
  const config = getConfig();
  let provider = getFailoverProvider(config.provider, config.providerOrder);
  const { rateLimit } = config;
  if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
    provider = new RateLimitProvider(
      provider,
      rateLimit,
      deps.sharedRequestTimestamps,
    );
  }

  const sendToClient = (serverMsg: ServerMessage) => {
    publishEvent(serverMsg, sessionId);
  };

  const sessionRef: { current?: ComputerUseSession } = {};
  const onTerminal = (sid: string) => {
    removeCuSessionReferences(deps, sid, sessionRef.current);
    log.info({ sessionId: sid }, "Computer-use session cleaned up after terminal state");
  };

  const { ComputerUseSession: CUSession } = await import(
    "../../daemon/computer-use-session.js"
  );

  const session = new CUSession(
    sessionId,
    task,
    screenWidth,
    screenHeight,
    provider,
    sendToClient,
    interactionType,
    onTerminal,
  );
  sessionRef.current = session;

  deps.cuSessions.set(sessionId, session);

  log.info(
    { sessionId, taskLength: task.length },
    "Task submitted via HTTP — CU session created",
  );

  return Response.json(
    { sessionId, interactionType: interactionType ?? "computer_use" },
    { status: 201 },
  );
}

/**
 * POST /v1/computer-use/ride-shotgun/start — start a ride-shotgun session.
 *
 * Body: { durationSeconds, intervalSeconds, mode?, targetDomain?, navigateDomain?, autoNavigate? }
 */
async function handleRideShotgunStartRoute(
  req: Request,
  deps: ComputerUseDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    durationSeconds?: number;
    intervalSeconds?: number;
    mode?: "observe" | "learn";
    targetDomain?: string;
    navigateDomain?: string;
    autoNavigate?: boolean;
  };

  const { durationSeconds, intervalSeconds, mode, targetDomain, navigateDomain, autoNavigate } = body;

  if (typeof durationSeconds !== "number" || durationSeconds <= 0) {
    return httpError("BAD_REQUEST", "durationSeconds must be a positive number", 400);
  }
  if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
    return httpError("BAD_REQUEST", "intervalSeconds must be a positive number", 400);
  }

  try {
    const result = await deps.handleRideShotgunStart({
      durationSeconds,
      intervalSeconds,
      mode,
      targetDomain,
      navigateDomain,
      autoNavigate,
    });

    log.info(
      { watchId: result.watchId, sessionId: result.sessionId, durationSeconds, mode },
      "Ride shotgun started via HTTP",
    );

    return Response.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to start ride shotgun via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

/**
 * POST /v1/computer-use/ride-shotgun/stop — stop a ride-shotgun session.
 *
 * Body: { watchId }
 */
async function handleRideShotgunStopRoute(
  req: Request,
  deps: ComputerUseDeps,
): Promise<Response> {
  const body = (await req.json()) as { watchId?: string };

  if (!body.watchId || typeof body.watchId !== "string") {
    return httpError("BAD_REQUEST", "watchId is required", 400);
  }

  try {
    await deps.handleRideShotgunStop(body.watchId);

    log.info({ watchId: body.watchId }, "Ride shotgun stopped via HTTP");
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, watchId: body.watchId }, "Failed to stop ride shotgun via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

/**
 * GET /v1/computer-use/ride-shotgun/status/:watchId — get ride-shotgun session status.
 */
function handleRideShotgunStatusRoute(
  watchId: string,
  deps: ComputerUseDeps,
): Response {
  const status = deps.getRideShotgunStatus(watchId);
  if (!status) {
    return httpError("NOT_FOUND", "Session not found", 404);
  }
  return Response.json(status);
}

/**
 * POST /v1/computer-use/watch — send a watch observation.
 *
 * Body: { watchId, sessionId, ocrText, appName?, windowTitle?,
 *         bundleIdentifier?, timestamp, captureIndex, totalExpected }
 */
async function handleWatchObservationRoute(
  req: Request,
  deps: ComputerUseDeps,
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
    log.error({ err, watchId: body.watchId }, "Failed to handle watch observation via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function computerUseRouteDefinitions(deps: {
  getComputerUseDeps?: () => ComputerUseDeps;
}): RouteDefinition[] {
  const getDeps = (): ComputerUseDeps => {
    if (!deps.getComputerUseDeps) {
      throw new Error("Computer use deps not available");
    }
    return deps.getComputerUseDeps();
  };

  return [
    {
      endpoint: "computer-use/sessions",
      method: "POST",
      policyKey: "computer-use/sessions",
      handler: async ({ req }) => handleCreateSession(req, getDeps()),
    },
    {
      endpoint: "computer-use/sessions/:id/abort",
      method: "POST",
      policyKey: "computer-use/sessions/abort",
      handler: ({ params }) => handleAbortSession(params.id, getDeps()),
    },
    {
      endpoint: "computer-use/observations",
      method: "POST",
      policyKey: "computer-use/observations",
      handler: async ({ req }) => handleObservation(req, getDeps()),
    },
    {
      endpoint: "computer-use/tasks",
      method: "POST",
      policyKey: "computer-use/tasks",
      handler: async ({ req }) => handleTaskSubmit(req, getDeps()),
    },
    {
      endpoint: "computer-use/ride-shotgun/start",
      method: "POST",
      policyKey: "computer-use/ride-shotgun/start",
      handler: async ({ req }) => handleRideShotgunStartRoute(req, getDeps()),
    },
    {
      endpoint: "computer-use/ride-shotgun/stop",
      method: "POST",
      policyKey: "computer-use/ride-shotgun/stop",
      handler: async ({ req }) => handleRideShotgunStopRoute(req, getDeps()),
    },
    {
      endpoint: "computer-use/ride-shotgun/status/:watchId",
      method: "GET",
      policyKey: "computer-use/ride-shotgun/status",
      handler: ({ params }) => handleRideShotgunStatusRoute(params.watchId, getDeps()),
    },
    {
      endpoint: "computer-use/watch",
      method: "POST",
      policyKey: "computer-use/watch",
      handler: async ({ req }) => handleWatchObservationRoute(req, getDeps()),
    },
  ];
}
