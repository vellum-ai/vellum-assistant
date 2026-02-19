/**
 * IPC handlers for subagent operations initiated by the client.
 */

import * as net from 'node:net';
import type { SubagentAbortRequest, SubagentStatusRequest, SubagentMessageRequest } from '../ipc-protocol.js';
import type { HandlerContext, DispatchMap } from './shared.js';
import { getSubagentManager } from '../../subagent/index.js';
import { log } from './shared.js';

export function handleSubagentAbort(
  msg: SubagentAbortRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Require the socket to have an active session (proves authentication), but
  // don't require it to match the subagent's parent — thread switching can leave
  // the socket bound to a different session than the one that spawned the subagent.
  // The subagent UUID is unguessable, so knowing it is sufficient authorization.
  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn({ subagentId: msg.subagentId }, 'Abort rejected: socket has no bound session');
    return;
  }

  const manager = getSubagentManager();
  const sendToClient = (m: unknown) => ctx.send(socket, m as Parameters<typeof ctx.send>[1]);
  const aborted = manager.abort(
    msg.subagentId,
    sendToClient as Parameters<typeof manager.abort>[1],
  );

  if (!aborted) {
    log.warn({ subagentId: msg.subagentId }, 'Client requested abort for unknown or terminal subagent');
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
    log.warn('Status rejected: socket has no bound session');
    return;
  }

  if (msg.subagentId) {
    const state = manager.getState(msg.subagentId);
    if (!state || state.config.parentSessionId !== callerSessionId) {
      ctx.send(socket, {
        type: 'error',
        message: `Subagent "${msg.subagentId}" not found.`,
        category: 'subagent_not_found',
      });
      return;
    }
    ctx.send(socket, {
      type: 'subagent_status_changed',
      subagentId: msg.subagentId,
      status: state.status,
      error: state.error,
      usage: state.usage,
    });
    return;
  }

  // Return all subagents for the caller's session.
  const sessionId = callerSessionId;
  const children = manager.getChildrenOf(sessionId);
  for (const child of children) {
    ctx.send(socket, {
      type: 'subagent_status_changed',
      subagentId: child.config.id,
      status: child.status,
      error: child.error,
      usage: child.usage,
    });
  }
}

export function handleSubagentMessage(
  msg: SubagentMessageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const callerSessionId = ctx.socketToSession.get(socket);
  if (!callerSessionId) {
    log.warn({ subagentId: msg.subagentId }, 'Message rejected: socket has no bound session');
    ctx.send(socket, {
      type: 'error',
      message: 'No active session.',
      category: 'subagent_not_found',
    });
    return;
  }

  const manager = getSubagentManager();

  // Ownership check: verify the caller owns this subagent.
  const state = manager.getState(msg.subagentId);
  if (!state || state.config.parentSessionId !== callerSessionId) {
    log.warn({ subagentId: msg.subagentId, callerSessionId }, 'Client sent message to unknown or unowned subagent');
    ctx.send(socket, {
      type: 'error',
      message: `Subagent "${msg.subagentId}" not found or in terminal state.`,
      category: 'subagent_not_found',
    });
    return;
  }

  const sent = manager.sendMessage(msg.subagentId, msg.content);

  if (!sent) {
    log.warn({ subagentId: msg.subagentId }, 'Client sent message to terminal subagent');
    ctx.send(socket, {
      type: 'error',
      message: `Subagent "${msg.subagentId}" not found or in terminal state.`,
      category: 'subagent_not_found',
    });
  }
}

export const subagentHandlers: Partial<DispatchMap> = {
  subagent_abort: handleSubagentAbort,
  subagent_status: handleSubagentStatus,
  subagent_message: handleSubagentMessage,
};
