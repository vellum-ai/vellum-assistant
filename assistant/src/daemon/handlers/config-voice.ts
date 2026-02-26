import * as net from 'node:net';

import type { VoiceConfigUpdateRequest } from '../ipc-contract/settings.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

/**
 * Send a client_settings_update message to all connected clients.
 * Used to push configuration changes (e.g. activation key) from the daemon
 * to macOS/iOS clients so they can apply settings immediately.
 */
export function broadcastClientSettingsUpdate(
  key: string,
  value: string,
  ctx: HandlerContext,
): void {
  ctx.broadcast({
    type: 'client_settings_update',
    key,
    value,
  });
  log.info({ key, value }, 'Broadcast client_settings_update');
}

// ── Activation key validation ────────────────────────────────────────

const VALID_ACTIVATION_KEYS = ['fn', 'ctrl', 'fn_shift', 'none'] as const;
export type ActivationKey = (typeof VALID_ACTIVATION_KEYS)[number];

/**
 * Map natural-language activation key names to canonical enum values.
 * Case-insensitive matching is applied by the caller.
 */
const NATURAL_LANGUAGE_MAP: Record<string, ActivationKey> = {
  fn: 'fn',
  globe: 'fn',
  'fn key': 'fn',
  'globe key': 'fn',
  ctrl: 'ctrl',
  control: 'ctrl',
  'ctrl key': 'ctrl',
  'control key': 'ctrl',
  fn_shift: 'fn_shift',
  'fn+shift': 'fn_shift',
  'fn shift': 'fn_shift',
  'shift+fn': 'fn_shift',
  none: 'none',
  off: 'none',
  disabled: 'none',
  disable: 'none',
};

/**
 * Validate and normalise a user-provided activation key string.
 * Accepts both canonical enum values and natural-language variants.
 * Returns the canonical value on success, or an error message on failure.
 */
export function normalizeActivationKey(
  input: string,
): { ok: true; value: ActivationKey } | { ok: false; reason: string } {
  const trimmed = input.trim().toLowerCase();

  // Direct enum match
  if ((VALID_ACTIVATION_KEYS as readonly string[]).includes(trimmed)) {
    return { ok: true, value: trimmed as ActivationKey };
  }

  // Natural-language match
  const mapped = NATURAL_LANGUAGE_MAP[trimmed];
  if (mapped) {
    return { ok: true, value: mapped };
  }

  return {
    ok: false,
    reason: `Invalid activation key "${input}". Valid values: fn (Fn/Globe key), ctrl (Control key), fn_shift (Fn+Shift), none (disable PTT).`,
  };
}

/**
 * Process a voice configuration update request from a session or IPC client.
 * Validates the activation key and broadcasts the change to all connected clients.
 */
export function handleVoiceConfigUpdate(
  msg: VoiceConfigUpdateRequest,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  const result = normalizeActivationKey(msg.activationKey);
  if (!result.ok) {
    log.warn({ input: msg.activationKey }, result.reason);
    return;
  }

  broadcastClientSettingsUpdate('activationKey', result.value, ctx);
  log.info({ activationKey: result.value }, 'Voice config updated: activation key');
}

export const voiceHandlers = defineHandlers({
  voice_config_update: handleVoiceConfigUpdate,
});
