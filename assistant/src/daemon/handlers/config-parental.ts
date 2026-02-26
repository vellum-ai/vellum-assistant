import * as net from 'node:net';

import {
  clearPIN,
  getActiveProfile,
  getParentalControlSettings,
  hasPIN,
  setActiveProfile,
  setPIN,
  updateParentalControlSettings,
  verifyPIN,
} from '../../security/parental-control-store.js';
import { getLogger } from '../../util/logger.js';
import type {
  ParentalControlAllowlistGetRequest,
  ParentalControlAllowlistUpdateRequest,
  ParentalControlGetRequest,
  ParentalControlProfileGetRequest,
  ParentalControlProfileSwitchRequest,
  ParentalControlSetPinRequest,
  ParentalControlUpdateRequest,
  ParentalControlVerifyPinRequest,
} from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext } from './shared.js';

const log = getLogger('parental-control');

function sendGetResponse(socket: net.Socket, ctx: HandlerContext): void {
  const settings = getParentalControlSettings();
  ctx.send(socket, {
    type: 'parental_control_get_response',
    enabled: settings.enabled,
    has_pin: hasPIN(),
    content_restrictions: settings.contentRestrictions,
    blocked_tool_categories: settings.blockedToolCategories,
    activeProfile: getActiveProfile(),
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

  // When enabling for the very first time, default all restrictions to ON so
  // the parent starts from a safe baseline. We track first-time initialization
  // with an explicit `initialized` flag rather than inferring it from empty
  // arrays, which would incorrectly re-apply defaults if the user intentionally
  // set both sections to "None" and then toggled parental controls off/on.
  const isFirstEnable = msg.enabled === true && !settings.initialized;

  const effectiveMsg = isFirstEnable ? {
    ...msg,
    content_restrictions: msg.content_restrictions ?? ['violence', 'adult_content', 'political', 'gambling', 'drugs'],
    blocked_tool_categories: msg.blocked_tool_categories ?? ['computer_use', 'network', 'shell', 'file_write'],
  } : msg;

  const updated = updateParentalControlSettings({
    enabled: effectiveMsg.enabled,
    contentRestrictions: effectiveMsg.content_restrictions,
    blockedToolCategories: effectiveMsg.blocked_tool_categories,
    // Mark as initialized once enabled for the first time so subsequent
    // enable/disable cycles preserve the user's chosen configuration.
    ...(isFirstEnable ? { initialized: true } : {}),
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

export function handleParentalControlProfileGet(
  _msg: ParentalControlProfileGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  ctx.send(socket, {
    type: 'parental_control_profile_get_response',
    activeProfile: getActiveProfile(),
  });
}

export function handleParentalControlProfileSwitch(
  msg: ParentalControlProfileSwitchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const currentProfile = getActiveProfile();

  // Validate targetProfile is one of the allowed values (TypeScript types are not enforced at runtime)
  if (msg.targetProfile !== 'parental' && msg.targetProfile !== 'child') {
    ctx.send(socket, {
      type: 'parental_control_profile_switch_response',
      success: false,
      activeProfile: currentProfile,
      error: 'Invalid target profile',
    });
    return;
  }

  // Switching TO parental from child requires PIN verification when a PIN is set.
  if (msg.targetProfile === 'parental' && hasPIN()) {
    if (!msg.pin) {
      ctx.send(socket, {
        type: 'parental_control_profile_switch_response',
        success: false,
        activeProfile: currentProfile,
        error: 'PIN required',
      });
      return;
    }
    if (!verifyPIN(msg.pin)) {
      ctx.send(socket, {
        type: 'parental_control_profile_switch_response',
        success: false,
        activeProfile: currentProfile,
        error: 'Invalid PIN',
      });
      return;
    }
  }

  setActiveProfile(msg.targetProfile);
  ctx.send(socket, {
    type: 'parental_control_profile_switch_response',
    success: true,
    activeProfile: msg.targetProfile,
  });
}

export function handleParentalControlAllowlistGet(
  _msg: ParentalControlAllowlistGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const settings = getParentalControlSettings();
  ctx.send(socket, {
    type: 'parental_control_allowlist_get_response',
    allowedApps: settings.allowedApps,
    allowedWidgets: settings.allowedWidgets,
  });
}

export function handleParentalControlAllowlistUpdate(
  msg: ParentalControlAllowlistUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const settings = getParentalControlSettings();
  const pinExists = hasPIN();

  // Require PIN verification when parental mode is already enabled
  if (settings.enabled && pinExists) {
    if (!msg.pin || !verifyPIN(msg.pin)) {
      ctx.send(socket, {
        type: 'parental_control_allowlist_update_response',
        success: false,
        allowedApps: settings.allowedApps,
        allowedWidgets: settings.allowedWidgets,
        error: 'PIN required to change parental control settings',
      });
      return;
    }
  }

  const updated = updateParentalControlSettings({
    allowedApps: msg.allowedApps,
    allowedWidgets: msg.allowedWidgets,
  });

  log.info(
    { appCount: updated.allowedApps.length, widgetCount: updated.allowedWidgets.length },
    'Parental control allowlist updated',
  );

  ctx.send(socket, {
    type: 'parental_control_allowlist_update_response',
    success: true,
    allowedApps: updated.allowedApps,
    allowedWidgets: updated.allowedWidgets,
  });
}

export const parentalControlHandlers = defineHandlers({
  parental_control_get: handleParentalControlGet,
  parental_control_verify_pin: handleParentalControlVerifyPin,
  parental_control_set_pin: handleParentalControlSetPin,
  parental_control_update: handleParentalControlUpdate,
  parental_control_profile_get: handleParentalControlProfileGet,
  parental_control_profile_switch: handleParentalControlProfileSwitch,
  parental_control_allowlist_get: handleParentalControlAllowlistGet,
  parental_control_allowlist_update: handleParentalControlAllowlistUpdate,
});
