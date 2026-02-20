/**
 * IPC handlers for subagent operations initiated by the client.
 */

import * as net from 'node:net';
import type { SubagentAbortRequest, SubagentStatusRequest, SubagentMessageRequest, SubagentDetailRequest } from '../ipc-protocol.js';
import * as conversationStore from '../../memory/conversation-store.js';
import type { HandlerContext } from './shared.js';
import { getSubagentManager } from '../../subagent/index.js';
import { log, defineHandlers, isRecord } from './shared.js';

export function handleSubagentAbort(
  msg: SubagentAbortRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
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
    callerSessionId,
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
  const children = manager.getChildrenOf(callerSessionId);
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

export function handleSubagentDetailRequest(
  msg: SubagentDetailRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const subagentMsgs = conversationStore.getMessages(msg.conversationId);

  // Extract objective from the first user message
  let objective: string | undefined;
  const firstUser = subagentMsgs.find(m => m.role === 'user');
  if (firstUser) {
    try {
      const parsed = JSON.parse(firstUser.content);
      if (Array.isArray(parsed)) {
        const textBlock = parsed.find((b: Record<string, unknown>) => isRecord(b) && b.type === 'text');
        if (textBlock && typeof textBlock.text === 'string') {
          objective = textBlock.text;
        }
      }
    } catch { /* ignore */ }
  }

  // Extract events from assistant messages
  const events: Array<{ type: string; content: string; toolName?: string; isError?: boolean }> = [];
  for (const m of subagentMsgs) {
    if (m.role !== 'assistant') continue;
    let content: unknown[];
    try {
      const parsed = JSON.parse(m.content);
      content = Array.isArray(parsed) ? parsed : [];
    } catch { continue; }

    const textParts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length > 0) {
      events.push({ type: 'text', content: textParts.join('') });
    }

    const pendingTools = new Map<string, string>();
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== 'string') continue;
      if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        const input = isRecord(block.input) ? block.input as Record<string, unknown> : {};
        const id = typeof block.id === 'string' ? block.id : '';
        events.push({ type: 'tool_use', content: JSON.stringify(input), toolName: name });
        if (id) pendingTools.set(id, name);
      }
      if (block.type === 'tool_result') {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const resultContent = typeof block.content === 'string' ? block.content : '';
        const isError = block.is_error === true;
        const toolName = toolUseId ? pendingTools.get(toolUseId) : undefined;
        events.push({ type: 'tool_result', content: resultContent, toolName: toolName ?? 'unknown', isError });
      }
    }
  }

  ctx.send(socket, {
    type: 'subagent_detail_response',
    subagentId: msg.subagentId,
    objective,
    events,
  });
}

export const subagentHandlers = defineHandlers({
  subagent_abort: handleSubagentAbort,
  subagent_status: handleSubagentStatus,
  subagent_message: handleSubagentMessage,
  subagent_detail_request: handleSubagentDetailRequest,
});
