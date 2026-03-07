import { isChannelId, isInterfaceId } from "../channels/types.js";
import inventory from "./ipc-contract-inventory.json" with { type: "json" };
import type { ClientMessage } from "./ipc-protocol.js";

/**
 * All known ClientMessage `type` discriminator values, derived from the
 * contract inventory snapshot so it stays in sync automatically.
 */
const KNOWN_CLIENT_TYPES = new Set<string>(inventory.clientWireTypes);

export type ValidationResult =
  | {
      valid: true;
      message: ClientMessage;
    }
  | {
      valid: false;
      reason: string;
    };

/**
 * Validate that a parsed JSON value is a well-formed ClientMessage envelope.
 *
 * Checks:
 * 1. Value is a non-null object
 * 2. Has a string `type` property
 * 3. `type` is in the known ClientMessage type set
 * 4. For high-risk message types, validates required properties
 */
export function validateClientMessage(value: unknown): ValidationResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "Message is not a JSON object" };
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.type !== "string") {
    return { valid: false, reason: 'Message is missing a string "type" field' };
  }

  if (!KNOWN_CLIENT_TYPES.has(obj.type)) {
    return { valid: false, reason: `Unknown message type: "${obj.type}"` };
  }

  // Property-level validation for high-risk message types
  const propError = validateHighRiskProperties(obj);
  if (propError) {
    return { valid: false, reason: propError };
  }

  return { valid: true, message: value as ClientMessage };
}

/**
 * Type guard shorthand — returns true when `value` is a structurally valid
 * ClientMessage, false otherwise.
 */
export function isClientMessageEnvelope(
  value: unknown,
): value is ClientMessage {
  return validateClientMessage(value).valid;
}

// ─── Property-level validation for high-risk messages ────────────────────────

type PropertyValidator = (obj: Record<string, unknown>) => string | null;

const HIGH_RISK_VALIDATORS: Record<string, PropertyValidator> = {
  auth: (obj) => {
    if (typeof obj.token !== "string" || obj.token === "") {
      return 'auth requires a non-empty string "token"';
    }
    return null;
  },

  user_message: (obj) => {
    if (typeof obj.sessionId !== "string" || obj.sessionId === "") {
      return 'user_message requires a non-empty string "sessionId"';
    }
    // content is optional (attachments-only messages are valid)
    if (obj.content !== undefined && typeof obj.content !== "string") {
      return 'user_message "content" must be a string when present';
    }
    if (obj.attachments !== undefined && !Array.isArray(obj.attachments)) {
      return 'user_message "attachments" must be an array when present';
    }
    if (
      obj.activeSurfaceId !== undefined &&
      typeof obj.activeSurfaceId !== "string"
    ) {
      return 'user_message "activeSurfaceId" must be a string when present';
    }
    if (obj.channel !== undefined && !isChannelId(obj.channel)) {
      return 'user_message "channel" must be a valid channel ID when present';
    }
    if (obj.interface === undefined) {
      return 'user_message requires a valid "interface" field';
    }
    if (!isInterfaceId(obj.interface)) {
      return 'user_message "interface" must be a valid interface ID';
    }
    return null;
  },

  session_create: (obj) => {
    if (obj.title !== undefined && typeof obj.title !== "string") {
      return 'session_create "title" must be a string when present';
    }
    if (
      obj.maxResponseTokens !== undefined &&
      typeof obj.maxResponseTokens !== "number"
    ) {
      return 'session_create "maxResponseTokens" must be a number when present';
    }
    if (obj.transport !== undefined) {
      if (
        obj.transport == null ||
        typeof obj.transport !== "object" ||
        Array.isArray(obj.transport)
      ) {
        return 'session_create "transport" must be an object when present';
      }
      const transport = obj.transport as Record<string, unknown>;
      if (
        typeof transport.channelId !== "string" ||
        transport.channelId.trim().length === 0
      ) {
        return 'session_create "transport.channelId" must be a non-empty string';
      }
      if (!isChannelId(transport.channelId)) {
        return 'session_create "transport.channelId" must be a valid channel ID';
      }
      if (transport.interfaceId !== undefined) {
        if (
          typeof transport.interfaceId !== "string" ||
          transport.interfaceId.trim().length === 0
        ) {
          return 'session_create "transport.interfaceId" must be a non-empty string when present';
        }
        if (!isInterfaceId(transport.interfaceId)) {
          return 'session_create "transport.interfaceId" must be a valid interface ID when present';
        }
      }
      if (
        transport.uxBrief !== undefined &&
        typeof transport.uxBrief !== "string"
      ) {
        return 'session_create "transport.uxBrief" must be a string when present';
      }
      if (transport.hints !== undefined) {
        if (
          !Array.isArray(transport.hints) ||
          !transport.hints.every((value) => typeof value === "string")
        ) {
          return 'session_create "transport.hints" must be an array of strings when present';
        }
      }
    }
    return null;
  },

  confirmation_response: (obj) => {
    if (typeof obj.requestId !== "string" || obj.requestId === "") {
      return 'confirmation_response requires a non-empty string "requestId"';
    }
    const validDecisions = [
      "allow",
      "allow_10m",
      "allow_thread",
      "always_allow",
      "always_allow_high_risk",
      "deny",
      "always_deny",
    ];
    if (
      typeof obj.decision !== "string" ||
      !validDecisions.includes(obj.decision)
    ) {
      return `confirmation_response "decision" must be one of: ${validDecisions.join(", ")}`;
    }
    return null;
  },

  secret_response: (obj) => {
    if (typeof obj.requestId !== "string" || obj.requestId === "") {
      return 'secret_response requires a non-empty string "requestId"';
    }
    // value is optional (undefined = user cancelled)
    if (obj.value !== undefined && typeof obj.value !== "string") {
      return 'secret_response "value" must be a string when present';
    }
    if (obj.delivery !== undefined) {
      const validDeliveries = ["store", "transient_send"];
      if (
        typeof obj.delivery !== "string" ||
        !validDeliveries.includes(obj.delivery)
      ) {
        return `secret_response "delivery" must be one of: ${validDeliveries.join(", ")}`;
      }
    }
    return null;
  },

  ipc_blob_probe: (obj) => {
    if (typeof obj.probeId !== "string" || obj.probeId === "") {
      return 'ipc_blob_probe requires a non-empty string "probeId"';
    }
    if (typeof obj.nonceSha256 !== "string" || obj.nonceSha256 === "") {
      return 'ipc_blob_probe requires a non-empty string "nonceSha256"';
    }
    return null;
  },

  add_trust_rule: (obj) => {
    if (typeof obj.toolName !== "string" || obj.toolName === "") {
      return 'add_trust_rule requires a non-empty string "toolName"';
    }
    if (typeof obj.pattern !== "string") {
      return 'add_trust_rule requires a string "pattern"';
    }
    if (typeof obj.scope !== "string") {
      return 'add_trust_rule requires a string "scope"';
    }
    const validDecisions = ["allow", "deny", "ask"];
    if (
      typeof obj.decision !== "string" ||
      !validDecisions.includes(obj.decision)
    ) {
      return `add_trust_rule "decision" must be one of: ${validDecisions.join(", ")}`;
    }
    return null;
  },

  ui_surface_action: (obj) => {
    if (typeof obj.sessionId !== "string" || obj.sessionId === "") {
      return 'ui_surface_action requires a non-empty string "sessionId"';
    }
    if (typeof obj.surfaceId !== "string" || obj.surfaceId === "") {
      return 'ui_surface_action requires a non-empty string "surfaceId"';
    }
    if (typeof obj.actionId !== "string" || obj.actionId === "") {
      return 'ui_surface_action requires a non-empty string "actionId"';
    }
    return null;
  },
};

function validateHighRiskProperties(
  obj: Record<string, unknown>,
): string | null {
  const validator = HIGH_RISK_VALIDATORS[obj.type as string];
  if (!validator) return null;
  return validator(obj);
}
