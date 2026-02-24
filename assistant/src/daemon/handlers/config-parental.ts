import * as net from 'node:net';
import type {
  ParentalControlGetRequest,
  ParentalControlVerifyPinRequest,
  ParentalControlSetPinRequest,
  ParentalControlUpdateRequest,
} from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext } from './shared.js';
import {
  getParentalControlSettings,
  updateParentalControlSettings,
  hasPIN,
  setPIN,
  verifyPIN,
  clearPIN,
} from '../../security/parental-control-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('parental-control');

function sendGetResponse(socket: net.Socket, ctx: HandlerContext): void {
  const settings = getParentalControlSettings();
  ctx.send(socket, {
    type: 'parental_control_get_response',
    enabled: settings.enabled,
    has_pin: hasPIN(),
    content_restrictions: settings.contentRestrictions,
    blocked_tool_categories: settings.blockedToolCategories,
  });
}

export function handleParentalControlGet(
  _msg: ParentalControlGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  sendGetResponse(socket, ctx);
}

export function handleParentalControlVerifyPin(
  msg: ParentalControlVerifyPinRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const verified = verifyPIN(msg.pin);
  ctx.send(socket, {
    type: 'parental_control_verify_pin_response',
    verified,
  });
}

export function handleParentalControlSetPin(
  msg: ParentalControlSetPinRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const pinExists = hasPIN();

    if (msg.clear) {
      // Clearing the PIN — must verify current PIN first
      if (pinExists) {
        if (!msg.current_pin || !verifyPIN(msg.current_pin)) {
          ctx.send(socket, {
            type: 'parental_control_set_pin_response',
            success: false,
            error: 'Current PIN is incorrect',
          });
          return;
        }
      }
      clearPIN();
      ctx.send(socket, {
        type: 'parental_control_set_pin_response',
        success: true,
      });
      return;
    }

    if (!msg.new_pin) {
      ctx.send(socket, {
        type: 'parental_control_set_pin_response',
        success: false,
        error: 'new_pin is required',
      });
      return;
    }

    if (pinExists) {
      // Changing existing PIN — must verify current PIN first
      if (!msg.current_pin || !verifyPIN(msg.current_pin)) {
        ctx.send(socket, {
          type: 'parental_control_set_pin_response',
          success: false,
          error: 'Current PIN is incorrect',
        });
        return;
      }
    }

    setPIN(msg.new_pin);
    ctx.send(socket, {
      type: 'parental_control_set_pin_response',
      success: true,
    });
  } catch (err) {
    log.error({ err }, 'Failed to set parental control PIN');
    ctx.send(socket, {
      type: 'parental_control_set_pin_response',
      success: false,
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
}

export function handleParentalControlUpdate(
  msg: ParentalControlUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const settings = getParentalControlSettings();
  const pinExists = hasPIN();

  // Require PIN verification when parental mode is already enabled
  if (settings.enabled && pinExists) {
    if (!msg.pin || !verifyPIN(msg.pin)) {
      ctx.send(socket, {
        type: 'parental_control_update_response',
        success: false,
        error: 'PIN required to change parental control settings',
        enabled: settings.enabled,
        has_pin: pinExists,
        content_restrictions: settings.contentRestrictions,
        blocked_tool_categories: settings.blockedToolCategories,
      });
      return;
    }
  }

  const updated = updateParentalControlSettings({
    enabled: msg.enabled,
    contentRestrictions: msg.content_restrictions,
    blockedToolCategories: msg.blocked_tool_categories,
  });

  log.info({ enabled: updated.enabled }, 'Parental control settings updated');

  ctx.send(socket, {
    type: 'parental_control_update_response',
    success: true,
    enabled: updated.enabled,
    has_pin: hasPIN(),
    content_restrictions: updated.contentRestrictions,
    blocked_tool_categories: updated.blockedToolCategories,
  });
}

export const parentalControlHandlers = defineHandlers({
  parental_control_get: handleParentalControlGet,
  parental_control_verify_pin: handleParentalControlVerifyPin,
  parental_control_set_pin: handleParentalControlSetPin,
  parental_control_update: handleParentalControlUpdate,
});
