import * as net from "node:net";

import { getConfig } from "../../config/loader.js";
import { RateLimitProvider } from "../../providers/ratelimit.js";
import { getFailoverProvider } from "../../providers/registry.js";
import { ComputerUseSession } from "../computer-use-session.js";
import type {
  CuObservation,
  CuSessionAbort,
  CuSessionCreate,
  ServerMessage,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

const cuObservationSequenceBySession = new Map<string, number>();

function removeCuSessionReferences(
  ctx: HandlerContext,
  sessionId: string,
  expectedSession?: ComputerUseSession,
): void {
  const current = ctx.cuSessions.get(sessionId);
  if (expectedSession && current && current !== expectedSession) {
    return;
  }
  ctx.cuSessions.delete(sessionId);
  cuObservationSequenceBySession.delete(sessionId);
  ctx.cuObservationParseSequence.delete(sessionId);
  for (const [sock, ids] of ctx.socketToCuSession) {
    if (ids.delete(sessionId) && ids.size === 0) {
      ctx.socketToCuSession.delete(sock);
    }
  }
}

export function handleCuSessionCreate(
  msg: CuSessionCreate,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Abort any existing session with the same ID to prevent zombies,
  // and remove it from the previous owner's socket set so disconnect
  // cleanup doesn't accidentally abort the replacement session.
  const existingSession = ctx.cuSessions.get(msg.sessionId);
  if (existingSession) {
    existingSession.abort();
    removeCuSessionReferences(ctx, msg.sessionId, existingSession);
  }

  const config = getConfig();
  let provider = getFailoverProvider(config.provider, config.providerOrder);
  const { rateLimit } = config;
  if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
    provider = new RateLimitProvider(
      provider,
      rateLimit,
      ctx.sharedRequestTimestamps,
    );
  }

  const sendToClient = (serverMsg: ServerMessage) => {
    ctx.send(socket, serverMsg);
  };

  const sessionRef: { current?: ComputerUseSession } = {};
  const onTerminal = (sessionId: string) => {
    removeCuSessionReferences(ctx, sessionId, sessionRef.current);
    log.info(
      { sessionId },
      "Computer-use session cleaned up after terminal state",
    );
  };

  const session = new ComputerUseSession(
    msg.sessionId,
    msg.task,
    msg.screenWidth,
    msg.screenHeight,
    provider,
    sendToClient,
    msg.interactionType,
    onTerminal,
  );
  sessionRef.current = session;

  ctx.cuSessions.set(msg.sessionId, session);

  // Track all CU sessions per socket so disconnect cleans up all of them
  let sessionIds = ctx.socketToCuSession.get(socket);
  if (!sessionIds) {
    sessionIds = new Set();
    ctx.socketToCuSession.set(socket, sessionIds);
  }
  sessionIds.add(msg.sessionId);

  log.info(
    { sessionId: msg.sessionId, taskLength: msg.task.length },
    "Computer-use session created",
  );
}

export function handleCuSessionAbort(
  msg: CuSessionAbort,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    log.debug(
      { sessionId: msg.sessionId },
      "CU session abort: session not found (already finished?)",
    );
    return;
  }
  session.abort();
  removeCuSessionReferences(ctx, msg.sessionId, session);
  log.info(
    { sessionId: msg.sessionId },
    "Computer-use session aborted by client",
  );
}

export async function handleCuObservation(
  msg: CuObservation,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const receiveTimestampMs = Date.now();

  const previousSequence =
    cuObservationSequenceBySession.get(msg.sessionId) ?? 0;
  const sequence = previousSequence + 1;
  cuObservationSequenceBySession.set(msg.sessionId, sequence);
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
    "IPC_METRIC cu_observation_daemon_receive",
  );

  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, {
      type: "cu_error",
      sessionId: msg.sessionId,
      message: `No computer-use session found for id ${msg.sessionId}`,
    });
    return;
  }

  // Fire-and-forget: the session sends messages via its sendToClient callback
  session.handleObservation(msg).catch((err) => {
    log.error(
      { err, sessionId: msg.sessionId },
      "Error handling CU observation",
    );
  });
}

export const computerUseHandlers = defineHandlers({
  cu_session_create: handleCuSessionCreate,
  cu_session_abort: handleCuSessionAbort,
  cu_observation: handleCuObservation,
});
