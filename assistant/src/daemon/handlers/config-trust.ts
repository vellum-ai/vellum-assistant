import * as net from 'node:net';
import { addRule, removeRule, updateRule, getAllRules, acceptStarterBundle } from '../../permissions/trust-store.js';
import type {
  AddTrustRule,
  RemoveTrustRule,
  UpdateTrustRule,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

export function handleAddTrustRule(
  msg: AddTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    const hasMetadata = msg.allowHighRisk != null
      || msg.executionTarget != null;

    addRule(
      msg.toolName,
      msg.pattern,
      msg.scope,
      msg.decision,
      undefined, // priority — use default
      hasMetadata
        ? {
            allowHighRisk: msg.allowHighRisk,
            executionTarget: msg.executionTarget,
          }
        : undefined,
    );
    log.info({ toolName: msg.toolName, pattern: msg.pattern, scope: msg.scope, decision: msg.decision }, 'Trust rule added via client');
  } catch (err) {
    log.error({ err, toolName: msg.toolName, pattern: msg.pattern, scope: msg.scope }, 'Failed to add trust rule via client');
  }
}

export function handleTrustRulesList(socket: net.Socket, ctx: HandlerContext): void {
  const rules = getAllRules();
  ctx.send(socket, { type: 'trust_rules_list_response', rules });
}

export function handleRemoveTrustRule(
  msg: RemoveTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    const removed = removeRule(msg.id);
    if (!removed) {
      log.warn({ id: msg.id }, 'Trust rule not found for removal');
    } else {
      log.info({ id: msg.id }, 'Trust rule removed via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to remove trust rule');
  }
}

export function handleUpdateTrustRule(
  msg: UpdateTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    updateRule(msg.id, {
      tool: msg.tool,
      pattern: msg.pattern,
      scope: msg.scope,
      decision: msg.decision,
      priority: msg.priority,
    });
    log.info({ id: msg.id }, 'Trust rule updated via client');
  } catch (err) {
    log.error({ err }, 'Failed to update trust rule');
  }
}

export function handleAcceptStarterBundle(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const result = acceptStarterBundle();
    ctx.send(socket, {
      type: 'accept_starter_bundle_response',
      accepted: result.accepted,
      rulesAdded: result.rulesAdded,
      alreadyAccepted: result.alreadyAccepted,
    });
    log.info({ rulesAdded: result.rulesAdded, alreadyAccepted: result.alreadyAccepted }, 'Starter bundle accepted via client');
  } catch (err) {
    log.error({ err }, 'Failed to accept starter bundle');
    ctx.send(socket, { type: 'error', message: 'Failed to accept starter bundle' });
  }
}

export const trustHandlers = defineHandlers({
  add_trust_rule: handleAddTrustRule,
  trust_rules_list: (_msg, socket, ctx) => handleTrustRulesList(socket, ctx),
  remove_trust_rule: handleRemoveTrustRule,
  update_trust_rule: handleUpdateTrustRule,
  accept_starter_bundle: (_msg, socket, ctx) => handleAcceptStarterBundle(socket, ctx),
});
