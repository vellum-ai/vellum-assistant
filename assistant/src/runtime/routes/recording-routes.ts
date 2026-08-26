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

import {
  claimRecording,
  getActiveRestartToken,
  handleRecordingPause,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStatusCore,
  handleRecordingStop,
  isRecordingIdle,
  ownsRecordingClaim,
} from "../../daemon/handlers/recording.js";
import type {
  RecordingOptions,
  RecordingStatus,
} from "../../daemon/message-protocol.js";
import { recordingTransferStore } from "../../daemon/recording-transfer.js";
import { getLogger } from "../../util/logger.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("recording-routes");
const MAX_RECORDING_CHUNK_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const recordingId = handleRecordingStart(
    body.conversationId,
    body.options as RecordingOptions | undefined,
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

function requireClientId(headers?: Record<string, string>): string {
  const clientId = headers?.["x-vellum-client-id"]?.trim();
  if (!clientId) {
    throw new BadRequestError("X-Vellum-Client-Id is required");
  }
  return clientId;
}

function handleClaimRecording({ body, headers }: RouteHandlerArgs) {
  const recordingId = body?.recordingId;
  if (typeof recordingId !== "string") {
    throw new BadRequestError("recordingId is required");
  }
  return {
    claimed: claimRecording(recordingId, requireClientId(headers), {
      isClientConnected: (clientId) =>
        Boolean(assistantEventHub.getClientById(clientId)),
    }),
  };
}

function requireRecordingOwner(recordingId: string, clientId: string): void {
  if (!ownsRecordingClaim(recordingId, clientId)) {
    throw new ConflictError("Recording belongs to another client");
  }
}

async function handleRecordingTransfer({ body, headers }: RouteHandlerArgs) {
  const recordingId = body?.recordingId;
  const operation = body?.operation;
  if (typeof recordingId !== "string") {
    throw new BadRequestError("recordingId is required");
  }
  if (typeof operation !== "string") {
    throw new BadRequestError("operation is required");
  }
  const clientId = requireClientId(headers);

  switch (operation) {
    case "begin":
      requireRecordingOwner(recordingId, clientId);
      await recordingTransferStore.begin(recordingId, clientId);
      return { ok: true };
    case "append": {
      requireRecordingOwner(recordingId, clientId);
      if (typeof body?.data !== "string") {
        throw new BadRequestError("data is required");
      }
      if (
        typeof body.sequence !== "number" ||
        !Number.isInteger(body.sequence) ||
        body.sequence < 0
      ) {
        throw new BadRequestError("sequence is required");
      }
      if (
        body.data.length >
        Math.ceil((MAX_RECORDING_CHUNK_BYTES * 4) / 3) + 4
      ) {
        throw new BadRequestError("Recording chunk is too large");
      }
      const chunk = Buffer.from(body.data, "base64");
      if (chunk.byteLength > MAX_RECORDING_CHUNK_BYTES) {
        throw new BadRequestError("Recording chunk is too large");
      }
      await recordingTransferStore.append(
        recordingId,
        clientId,
        body.sequence,
        chunk,
      );
      return { ok: true };
    }
    case "finish":
      requireRecordingOwner(recordingId, clientId);
      return {
        ok: true,
        attachmentId: await recordingTransferStore.finish(
          recordingId,
          clientId,
        ),
      };
    case "abort":
      requireRecordingOwner(recordingId, clientId);
      await recordingTransferStore.abort(recordingId, clientId);
      return { ok: true };
    default:
      throw new BadRequestError(`Invalid operation: ${operation}`);
  }
}

async function handleStopRecording({ body }: RouteHandlerArgs) {
  if (!body?.conversationId || typeof body.conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const recordingId = handleRecordingStop(body.conversationId);

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

  const recordingId = handleRecordingPause(body.conversationId);

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

  const recordingId = handleRecordingResume(body.conversationId);

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

async function handlePostRecordingStatus({ body, headers }: RouteHandlerArgs) {
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

  requireRecordingOwner(body.conversationId, requireClientId(headers));

  const msg: RecordingStatus = {
    ...(body as Omit<RecordingStatus, "type">),
    type: "recording_status",
  };

  try {
    await handleRecordingStatusCore(msg);
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    operationId: "recordings_claim",
    endpoint: "recordings/claim",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Claim recording",
    description: "Atomically claim a recording for one connected client.",
    tags: ["recordings"],
    requestBody: z.object({
      recordingId: z.string().uuid(),
    }),
    responseBody: z.object({
      claimed: z.boolean(),
    }),
    handler: handleClaimRecording,
  },
  {
    operationId: "recordings_transfer",
    endpoint: "recordings/transfer",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Transfer recording",
    description: "Append recording chunks into a file-backed attachment.",
    tags: ["recordings"],
    requestBody: z.object({
      recordingId: z.string().uuid(),
      operation: z.enum(["begin", "append", "finish", "abort"]),
      sequence: z.number().int().nonnegative().optional(),
      data: z.string().optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      attachmentId: z.string().optional(),
    }),
    handler: handleRecordingTransfer,
  },
  {
    operationId: "recordings_stop",
    endpoint: "recordings/stop",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      attachmentId: z.string().optional(),
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
