import type { VoiceConfigUpdateRequest } from "../message-types/settings.js";
import { type HandlerContext, log } from "./shared.js";

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
    type: "client_settings_update",
    key,
    value,
  });
  log.info({ key, value }, "Broadcast client_settings_update");
}

// ── Activation key validation ────────────────────────────────────────

const VALID_ACTIVATION_KEYS = ["fn", "ctrl", "fn_shift", "none"] as const;
export type ActivationKey = (typeof VALID_ACTIVATION_KEYS)[number];

/**
 * Map natural-language activation key names to canonical enum values.
 * Case-insensitive matching is applied by the caller.
 */
const NATURAL_LANGUAGE_MAP: Record<string, ActivationKey> = {
  fn: "fn",
  globe: "fn",
  "fn key": "fn",
  "globe key": "fn",
  ctrl: "ctrl",
  control: "ctrl",
  "ctrl key": "ctrl",
  "control key": "ctrl",
  fn_shift: "fn_shift",
  "fn+shift": "fn_shift",
  "fn shift": "fn_shift",
  "shift+fn": "fn_shift",
  none: "none",
  off: "none",
  disabled: "none",
  disable: "none",
};

// ── PTTActivator JSON validation ─────────────────────────────────────

const VALID_KINDS = [
  "modifierOnly",
  "key",
  "modifierKey",
  "mouseButton",
  "none",
] as const;
type PTTKind = (typeof VALID_KINDS)[number];

interface PTTActivatorPayload {
  kind: PTTKind;
  keyCode?: number | null;
  modifierFlags?: number | null;
  mouseButton?: number | null;
}

/**
 * Validate a parsed PTTActivator JSON payload.
 * Returns an error message if invalid, or null if valid.
 */
function validatePTTActivator(payload: PTTActivatorPayload): string | null {
  if (!VALID_KINDS.includes(payload.kind)) {
    return `Invalid kind "${payload.kind}". Valid values: ${VALID_KINDS.join(", ")}`;
  }

  // Enforce numeric types for fields that the Swift client decodes as numbers.
  // Without this, JS coercion lets string values like "96" pass range checks
  // but the macOS client fails to decode them as UInt16/Int/UInt.
  if (payload.keyCode != null && typeof payload.keyCode !== "number") {
    return `keyCode must be a number, got ${typeof payload.keyCode}`;
  }
  if (
    payload.modifierFlags != null &&
    typeof payload.modifierFlags !== "number"
  ) {
    return `modifierFlags must be a number, got ${typeof payload.modifierFlags}`;
  }
  if (payload.mouseButton != null && typeof payload.mouseButton !== "number") {
    return `mouseButton must be a number, got ${typeof payload.mouseButton}`;
  }

  switch (payload.kind) {
    case "modifierOnly":
      if (payload.modifierFlags == null) {
        return "modifierOnly requires modifierFlags";
      }
      if (payload.keyCode != null || payload.mouseButton != null) {
        return "modifierOnly must not have keyCode or mouseButton";
      }
      break;

    case "key":
      if (payload.keyCode == null) {
        return "key requires keyCode";
      }
      if (payload.keyCode < 0 || payload.keyCode > 255) {
        return `keyCode must be 0-255, got ${payload.keyCode}`;
      }
      if (payload.mouseButton != null) {
        return "key must not have mouseButton";
      }
      break;

    case "modifierKey":
      if (payload.keyCode == null) {
        return "modifierKey requires keyCode";
      }
      if (payload.keyCode < 0 || payload.keyCode > 255) {
        return `keyCode must be 0-255, got ${payload.keyCode}`;
      }
      if (payload.modifierFlags == null) {
        return "modifierKey requires modifierFlags";
      }
      if (payload.mouseButton != null) {
        return "modifierKey must not have mouseButton";
      }
      break;

    case "mouseButton":
      if (payload.mouseButton == null) {
        return "mouseButton requires mouseButton field";
      }
      if (payload.mouseButton < 2) {
        return `mouseButton must be >= 2 (left=0, right=1 are reserved), got ${payload.mouseButton}`;
      }
      if (payload.keyCode != null) {
        return "mouseButton must not have keyCode";
      }
      break;

    case "none":
      // No required fields
      break;
  }

  return null;
}

/**
 * Validate and normalise a user-provided activation key string.
 * Accepts legacy enum values, natural-language variants, and PTTActivator JSON.
 * Returns the canonical value on success, or an error message on failure.
 */
export function normalizeActivationKey(
  input: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = input.trim();

  // Try JSON parse first (PTTActivator payloads start with '{')
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as PTTActivatorPayload;
      const error = validatePTTActivator(parsed);
      if (error) {
        return { ok: false, reason: `Invalid PTTActivator: ${error}` };
      }
      // Pass through the validated JSON as-is
      return { ok: true, value: trimmed };
    } catch {
      return {
        ok: false,
        reason: `Malformed PTTActivator JSON: ${input}`,
      };
    }
  }

  // Legacy: direct enum match
  const lower = trimmed.toLowerCase();
  if ((VALID_ACTIVATION_KEYS as readonly string[]).includes(lower)) {
    return { ok: true, value: lower as ActivationKey };
  }

  // Legacy: natural-language match
  const mapped = NATURAL_LANGUAGE_MAP[lower];
  if (mapped) {
    return { ok: true, value: mapped };
  }

  return {
    ok: false,
    reason: `Invalid activation key "${input}". Valid values: fn (Fn/Globe key), ctrl (Control key), fn_shift (Fn+Shift), none (disable PTT), or a PTTActivator JSON object.`,
  };
}

/**
 * Process a voice configuration update request from a conversation or client.
 * Validates the activation key and broadcasts the change to all connected clients.
 */
export function handleVoiceConfigUpdate(
  msg: VoiceConfigUpdateRequest,
  ctx: HandlerContext,
): void {
  const result = normalizeActivationKey(msg.activationKey);
  if (!result.ok) {
    log.warn({ input: msg.activationKey }, result.reason);
    return;
  }

  broadcastClientSettingsUpdate("activationKey", result.value, ctx);
  log.info(
    { activationKey: result.value },
    "Voice config updated: activation key",
  );
}
