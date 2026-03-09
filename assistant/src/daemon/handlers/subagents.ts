/**
 * IPC handlers for subagent operations initiated by the client.
 */

import * as net from "node:net";

import { getSubagentDetail } from "../../runtime/routes/subagents-routes.js";
import { getSubagentManager } from "../../subagent/index.js";
import type {
  SubagentAbortRequest,
  SubagentDetailRequest,
  SubagentMessageRequest,
  SubagentStatusRequest,
} from "../ipc-protocol.js";
import type { HandlerContext } from "./shared.js";
import { defineHandlers, log } from "./shared.js";

export function handleSubagentAbort(
  msg: SubagentAbortRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn(
      { subagentId: msg.subagentId },
      "Abort rejected: socket has no bound session",
    );
    return;
  }

  const manager = getSubagentManager();
  const sendToClient = (m: unknown) =>
    ctx.send(socket, m as Parameters<typeof ctx.send>[1]);
  const aborted = manager.abort(
    msg.subagentId,
    sendToClient as Parameters<typeof manager.abort>[1],
    callerSessionId,
  );

  if (!aborted) {
    log.warn(
      { subagentId: msg.subagentId },
      "Client requested abort for unknown or terminal subagent",
    );
  }
}

export function handleSubagentStatus(
  msg: SubagentStatusRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const manager = getSubagentManager();

  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn("Status rejected: socket has no bound session");
    return;
  }

  if (msg.subagentId) {
    const state = manager.getState(msg.subagentId);
    if (!state || state.config.parentSessionId !== callerSessionId) {
      ctx.send(socket, {
        type: "error",
        message: `Subagent "${msg.subagentId}" not found.`,
        category: "subagent_not_found",
      });
      return;
    }
    ctx.send(socket, {
      type: "subagent_status_changed",
      subagentId: msg.subagentId,
      status: state.status,
      error: state.error,
      usage: state.usage,
    });
    return;
  }

  // Return all subagents for the caller's session.
  const children = manager.getChildrenOf(callerSessionId);
  for (const child of children) {
    ctx.send(socket, {
      type: "subagent_status_changed",
      subagentId: child.config.id,
      status: child.status,
      error: child.error,
      usage: child.usage,
    });
  }
}

export async function handleSubagentMessage(
  msg: SubagentMessageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn(
      { subagentId: msg.subagentId },
      "Message rejected: socket has no bound session",
    );
    ctx.send(socket, {
      type: "error",
      message: "No active session.",
      category: "subagent_not_found",
    });
    return;
  }

  const manager = getSubagentManager();

  // Ownership check: verify the caller owns this subagent.
  const state = manager.getState(msg.subagentId);
  if (!state || state.config.parentSessionId !== callerSessionId) {
    log.warn(
      { subagentId: msg.subagentId, callerSessionId },
      "Client sent message to unknown or unowned subagent",
    );
    ctx.send(socket, {
      type: "error",
      message: `Subagent "${msg.subagentId}" not found or in terminal state.`,
      category: "subagent_not_found",
    });
    return;
  }

  const result = await manager.sendMessage(msg.subagentId, msg.content);

  if (result === "queue_full") {
    log.warn(
      { subagentId: msg.subagentId },
      "Subagent message rejected — queue full",
    );
    ctx.send(socket, {
      type: "error",
      message: `Subagent "${msg.subagentId}" message queue is full. Please wait for current messages to be processed.`,
      category: "queue_full",
    });
  } else if (result === "empty") {
    log.warn(
      { subagentId: msg.subagentId },
      "Subagent message rejected — empty content",
    );
    ctx.send(socket, {
      type: "error",
      message: "Message content is empty or whitespace-only.",
      category: "empty_content",
    });
  } else if (result !== "sent") {
    log.warn(
      { subagentId: msg.subagentId, reason: result },
      "Client sent message to terminal subagent",
    );
    ctx.send(socket, {
      type: "error",
      message: `Subagent "${msg.subagentId}" not found or in terminal state.`,
      category: "subagent_not_found",
    });
  }
}

export function handleSubagentDetailRequest(
  msg: SubagentDetailRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Ownership check: reject if the socket has no bound session.
  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn(
      { subagentId: msg.subagentId },
      "Detail request rejected: socket has no bound session",
    );
    return;
  }

  // If the subagent is still in memory, verify the caller owns it.
  // After daemon restart getState() returns null — we allow the request
  // since the conversationId itself acts as a capability token (the client
  // only knows it because it was sent in a prior subagent_notification).
  const manager = getSubagentManager();
  const state = manager.getState(msg.subagentId);
  if (state && state.config.parentSessionId !== callerSessionId) {
    log.warn(
      { subagentId: msg.subagentId, callerSessionId },
      "Detail request rejected: subagent not owned by caller",
    );
    return;
  }

  const result = getSubagentDetail(msg.subagentId, msg.conversationId);

  ctx.send(socket, {
    type: "subagent_detail_response",
    ...result,
  });
}

export const subagentHandlers = defineHandlers({
  subagent_abort: handleSubagentAbort,
  subagent_status: handleSubagentStatus,
  subagent_message: handleSubagentMessage,
  subagent_detail_request: handleSubagentDetailRequest,
});
