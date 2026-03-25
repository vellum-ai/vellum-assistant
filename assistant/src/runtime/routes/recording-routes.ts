/**
 * HTTP route handlers for screen recording lifecycle.
 *
 * These endpoints expose recording start/stop/pause/resume/status
 * functionality over HTTP. Recording commands are broadcast to connected
 * clients via the assistant event hub (SSE).
 *
 * Recording write operations require `settings.write`; status queries
 * require `settings.read`.
 */

import {
  getActiveRestartToken,
  handleRecordingPause,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStatusCore,
  handleRecordingStop,
  isRecordingIdle,
} from "../../daemon/handlers/recording.js";
import type { HandlerContext } from "../../daemon/handlers/shared.js";
import type {
  RecordingOptions,
  RecordingStatus,
} from "../../daemon/message-protocol.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("recording-routes");

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for recording operations.
 * The daemon wires a concrete HandlerContext at startup.
 */
export interface RecordingDeps {
  /** The daemon's handler context for recording operations. */
  getHandlerContext: () => HandlerContext;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/recordings/start — start a screen recording.
 *
 * Body: { conversationId, options? }
 * options: { captureScope?, displayId?, windowId?, includeAudio?,
 *            includeMicrophone?, promptForSource? }
 */
async function handleStartRecording(
  req: Request,
  deps: RecordingDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string;
    options?: RecordingOptions;
  };

  if (!body.conversationId || typeof body.conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  const ctx = deps.getHandlerContext();

  const recordingId = handleRecordingStart(
    body.conversationId,
    body.options,
    ctx,
  );

  if (!recordingId) {
    const isIdle = isRecordingIdle();
    const reason = isIdle ? "unknown" : "A recording is already active";
    log.warn(
      { conversationId: body.conversationId, isIdle },
      "Recording start failed via HTTP",
    );
    return httpError("CONFLICT", reason, 409);
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording started via HTTP",
  );

  return Response.json({ recordingId }, { status: 201 });
}

/**
 * POST /v1/recordings/stop — stop the active recording.
 *
 * Body: { conversationId }
 */
async function handleStopRecording(
  req: Request,
  deps: RecordingDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string;
  };

  if (!body.conversationId || typeof body.conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  const ctx = deps.getHandlerContext();
  const recordingId = handleRecordingStop(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to stop via HTTP",
    );
    return httpError("NOT_FOUND", "No active recording to stop", 404);
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording stop sent via HTTP",
  );

  return Response.json({ recordingId, stopped: true });
}

/**
 * POST /v1/recordings/pause — pause the active recording.
 *
 * Body: { conversationId }
 */
async function handlePauseRecording(
  req: Request,
  deps: RecordingDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string;
  };

  if (!body.conversationId || typeof body.conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  const ctx = deps.getHandlerContext();
  const recordingId = handleRecordingPause(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to pause via HTTP",
    );
    return httpError("NOT_FOUND", "No active recording to pause", 404);
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording pause sent via HTTP",
  );

  return Response.json({ recordingId, paused: true });
}

/**
 * POST /v1/recordings/resume — resume a paused recording.
 *
 * Body: { conversationId }
 */
async function handleResumeRecording(
  req: Request,
  deps: RecordingDeps,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string;
  };

  if (!body.conversationId || typeof body.conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  const ctx = deps.getHandlerContext();
  const recordingId = handleRecordingResume(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to resume via HTTP",
    );
    return httpError("NOT_FOUND", "No active recording to resume", 404);
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording resume sent via HTTP",
  );

  return Response.json({ recordingId, resumed: true });
}

/**
 * GET /v1/recordings/status — get current recording status.
 */
function handleGetRecordingStatus(): Response {
  const idle = isRecordingIdle();
  const activeRestartToken = getActiveRestartToken();

  return Response.json({
    idle,
    restartInProgress: Boolean(activeRestartToken),
  });
}

/**
 * POST /v1/recordings/status — recording lifecycle callback from the client.
 *
 * Body: RecordingStatus fields (conversationId, status, filePath?, durationMs?,
 *       error?, attachToConversationId?, operationToken?)
 *
 * The client sends this when a recording transitions state (started, stopped,
 * paused, resumed, failed, restart_cancelled). The handler performs conversation
 * ID resolution, operation token validation, file attachment after stop,
 * broadcasting lifecycle events, and triggering deferred recording restarts.
 */
async function handlePostRecordingStatus(
  req: Request,
  deps: RecordingDeps,
): Promise<Response> {
  const body = (await req.json()) as Omit<RecordingStatus, "type">;

  if (!body.conversationId || typeof body.conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  if (!body.status || typeof body.status !== "string") {
    return httpError("BAD_REQUEST", "status is required", 400);
  }

  const validStatuses = [
    "started",
    "stopped",
    "failed",
    "restart_cancelled",
    "paused",
    "resumed",
  ];
  if (!validStatuses.includes(body.status)) {
    return httpError("BAD_REQUEST", `Invalid status: ${body.status}`, 400);
  }

  const msg: RecordingStatus = {
    ...body,
    type: "recording_status",
  };

  const ctx = deps.getHandlerContext();

  try {
    await handleRecordingStatusCore(msg, ctx);
  } catch (err) {
    log.error(
      { err, conversationId: body.conversationId, status: body.status },
      "Recording status handler failed",
    );
    return httpError(
      "INTERNAL_ERROR",
      "Recording status processing failed",
      500,
    );
  }

  log.info(
    { conversationId: body.conversationId, status: body.status },
    "Recording status processed via HTTP",
  );

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function recordingRouteDefinitions(deps: {
  getRecordingDeps?: () => RecordingDeps;
}): RouteDefinition[] {
  const getDeps = (): RecordingDeps => {
    if (!deps.getRecordingDeps) {
      throw new Error("Recording deps not available");
    }
    return deps.getRecordingDeps();
  };

  return [
    {
      endpoint: "recordings/start",
      method: "POST",
      policyKey: "recordings/start",
      summary: "Start recording",
      description: "Start a screen recording for a conversation.",
      tags: ["recordings"],
      requestBody: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          options: { type: "object", description: "Recording options" },
        },
        required: ["conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          recordingId: { type: "string" },
        },
      },
      handler: async ({ req }) => handleStartRecording(req, getDeps()),
    },
    {
      endpoint: "recordings/stop",
      method: "POST",
      policyKey: "recordings/stop",
      summary: "Stop recording",
      description: "Stop the active screen recording.",
      tags: ["recordings"],
      requestBody: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          recordingId: { type: "string" },
          stopped: { type: "boolean" },
        },
      },
      handler: async ({ req }) => handleStopRecording(req, getDeps()),
    },
    {
      endpoint: "recordings/pause",
      method: "POST",
      policyKey: "recordings/pause",
      summary: "Pause recording",
      description: "Pause the active screen recording.",
      tags: ["recordings"],
      requestBody: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          recordingId: { type: "string" },
          paused: { type: "boolean" },
        },
      },
      handler: async ({ req }) => handlePauseRecording(req, getDeps()),
    },
    {
      endpoint: "recordings/resume",
      method: "POST",
      policyKey: "recordings/resume",
      summary: "Resume recording",
      description: "Resume a paused screen recording.",
      tags: ["recordings"],
      requestBody: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          recordingId: { type: "string" },
          resumed: { type: "boolean" },
        },
      },
      handler: async ({ req }) => handleResumeRecording(req, getDeps()),
    },
    {
      endpoint: "recordings/status",
      method: "GET",
      policyKey: "recordings/status",
      summary: "Get recording status",
      description: "Return the current recording state.",
      tags: ["recordings"],
      responseBody: {
        type: "object",
        properties: {
          idle: { type: "boolean" },
          restartInProgress: { type: "boolean" },
        },
      },
      handler: () => handleGetRecordingStatus(),
    },
    {
      endpoint: "recordings/status",
      method: "POST",
      policyKey: "recordings/status:POST",
      summary: "Post recording status",
      description: "Recording lifecycle callback from the client.",
      tags: ["recordings"],
      requestBody: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          status: {
            type: "string",
            description:
              "started, stopped, failed, restart_cancelled, paused, resumed",
          },
          filePath: { type: "string" },
          durationMs: { type: "number" },
          error: { type: "string" },
          attachToConversationId: { type: "string" },
          operationToken: { type: "string" },
        },
        required: ["conversationId", "status"],
      },
      responseBody: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
      },
      handler: async ({ req }) => handlePostRecordingStatus(req, getDeps()),
    },
  ];
}
