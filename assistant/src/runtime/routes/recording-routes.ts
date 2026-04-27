/**
 * Transport-agnostic route definitions for screen recording lifecycle.
 *
 * POST /v1/recordings/start   — start a screen recording
 * POST /v1/recordings/stop    — stop the active recording
 * POST /v1/recordings/pause   — pause the active recording
 * POST /v1/recordings/resume  — resume a paused recording
 * GET  /v1/recordings/status  — get current recording state
 * POST /v1/recordings/status  — recording lifecycle callback from the client
 *
 * Recording write operations require `settings.write`; status queries
 * require `settings.read`.
 */

import { z } from "zod";

import { broadcastToAllClients } from "../../acp/index.js";
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
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("recording-routes");

// ---------------------------------------------------------------------------
// Broadcast shim — recording handlers only use ctx.broadcast()
// ---------------------------------------------------------------------------

function getBroadcastCtx(): HandlerContext {
  if (!broadcastToAllClients) {
    throw new InternalError("Broadcast not initialized");
  }
  return { broadcast: broadcastToAllClients } as HandlerContext;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const ctx = getBroadcastCtx();
  const recordingId = handleRecordingStart(
    body.conversationId,
    body.options as RecordingOptions | undefined,
    ctx,
  );

  if (!recordingId) {
    const idle = isRecordingIdle();
    const reason = idle ? "unknown" : "A recording is already active";
    log.warn(
      { conversationId: body.conversationId, isIdle: idle },
      "Recording start failed via HTTP",
    );
    throw new ConflictError(reason);
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording started via HTTP",
  );

  return { recordingId };
}

async function handleStopRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const ctx = getBroadcastCtx();
  const recordingId = handleRecordingStop(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to stop via HTTP",
    );
    throw new NotFoundError("No active recording to stop");
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording stop sent via HTTP",
  );

  return { recordingId, stopped: true };
}

async function handlePauseRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const ctx = getBroadcastCtx();
  const recordingId = handleRecordingPause(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to pause via HTTP",
    );
    throw new NotFoundError("No active recording to pause");
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording pause sent via HTTP",
  );

  return { recordingId, paused: true };
}

async function handleResumeRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const ctx = getBroadcastCtx();
  const recordingId = handleRecordingResume(body.conversationId, ctx);

  if (!recordingId) {
    log.debug(
      { conversationId: body.conversationId },
      "No active recording to resume via HTTP",
    );
    throw new NotFoundError("No active recording to resume");
  }

  log.info(
    { recordingId, conversationId: body.conversationId },
    "Recording resume sent via HTTP",
  );

  return { recordingId, resumed: true };
}

function handleGetRecordingStatus() {
  const idle = isRecordingIdle();
  const activeRestartToken = getActiveRestartToken();

  return {
    idle,
    restartInProgress: Boolean(activeRestartToken),
  };
}

const VALID_RECORDING_STATUSES = [
  "started",
  "stopped",
  "failed",
  "restart_cancelled",
  "paused",
  "resumed",
] as const;

async function handlePostRecordingStatus({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  if (!body.status || typeof body.status !== "string") {
    throw new BadRequestError("status is required");
  }

  if (
    !VALID_RECORDING_STATUSES.includes(
      body.status as (typeof VALID_RECORDING_STATUSES)[number],
    )
  ) {
    throw new BadRequestError(`Invalid status: ${body.status}`);
  }

  const msg: RecordingStatus = {
    ...(body as Omit<RecordingStatus, "type">),
    type: "recording_status",
  };

  const ctx = getBroadcastCtx();

  try {
    await handleRecordingStatusCore(msg, ctx);
  } catch (err) {
    log.error(
      { err, conversationId: body.conversationId, status: body.status },
      "Recording status handler failed",
    );
    throw new InternalError("Recording status processing failed");
  }

  log.info(
    { conversationId: body.conversationId, status: body.status },
    "Recording status processed via HTTP",
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "recordings_start",
    endpoint: "recordings/start",
    method: "POST",
    policyKey: "recordings/start",
    requirePolicyEnforcement: true,
    summary: "Start recording",
    description: "Start a screen recording for a conversation.",
    tags: ["recordings"],
    responseStatus: "201",
    requestBody: z.object({
      conversationId: z.string(),
      options: z
        .object({})
        .passthrough()
        .describe("Recording options")
        .optional(),
    }),
    responseBody: z.object({
      recordingId: z.string(),
    }),
    handler: handleStartRecording,
  },
  {
    operationId: "recordings_stop",
    endpoint: "recordings/stop",
    method: "POST",
    policyKey: "recordings/stop",
    requirePolicyEnforcement: true,
    summary: "Stop recording",
    description: "Stop the active screen recording.",
    tags: ["recordings"],
    requestBody: z.object({
      conversationId: z.string(),
    }),
    responseBody: z.object({
      recordingId: z.string(),
      stopped: z.boolean(),
    }),
    handler: handleStopRecording,
  },
  {
    operationId: "recordings_pause",
    endpoint: "recordings/pause",
    method: "POST",
    policyKey: "recordings/pause",
    requirePolicyEnforcement: true,
    summary: "Pause recording",
    description: "Pause the active screen recording.",
    tags: ["recordings"],
    requestBody: z.object({
      conversationId: z.string(),
    }),
    responseBody: z.object({
      recordingId: z.string(),
      paused: z.boolean(),
    }),
    handler: handlePauseRecording,
  },
  {
    operationId: "recordings_resume",
    endpoint: "recordings/resume",
    method: "POST",
    policyKey: "recordings/resume",
    requirePolicyEnforcement: true,
    summary: "Resume recording",
    description: "Resume a paused screen recording.",
    tags: ["recordings"],
    requestBody: z.object({
      conversationId: z.string(),
    }),
    responseBody: z.object({
      recordingId: z.string(),
      resumed: z.boolean(),
    }),
    handler: handleResumeRecording,
  },
  {
    operationId: "recordings_status_get",
    endpoint: "recordings/status",
    method: "GET",
    policyKey: "recordings/status",
    requirePolicyEnforcement: true,
    summary: "Get recording status",
    description: "Return the current recording state.",
    tags: ["recordings"],
    responseBody: z.object({
      idle: z.boolean(),
      restartInProgress: z.boolean(),
    }),
    handler: handleGetRecordingStatus,
  },
  {
    operationId: "recordings_status_post",
    endpoint: "recordings/status",
    method: "POST",
    policyKey: "recordings/status:POST",
    requirePolicyEnforcement: true,
    summary: "Post recording status",
    description: "Recording lifecycle callback from the client.",
    tags: ["recordings"],
    requestBody: z.object({
      conversationId: z.string(),
      status: z
        .string()
        .describe(
          "started, stopped, failed, restart_cancelled, paused, resumed",
        ),
      filePath: z.string().optional(),
      durationMs: z.number().optional(),
      error: z.string().optional(),
      attachToConversationId: z.string().optional(),
      operationToken: z.string().optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handlePostRecordingStatus,
  },
];
