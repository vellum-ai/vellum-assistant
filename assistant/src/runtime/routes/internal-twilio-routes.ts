/**
 * Internal Twilio webhook forwarding routes (gateway → runtime).
 *
 * These routes accept pre-parsed webhook payloads from the gateway
 * and delegate to the core voice webhook logic in twilio-routes.ts.
 */

import {
  handleInternalStatusCallback,
  handleInternalVoiceWebhook,
} from "../../calls/twilio-routes.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_twilio_voice_webhook",
    endpoint: "internal/twilio/voice-webhook",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Internal Twilio voice webhook",
    description:
      "Gateway-to-runtime forwarding for Twilio voice webhook. Accepts pre-parsed form params as JSON.",
    tags: ["internal"],
    handler: handleInternalVoiceWebhook,
  },
  {
    operationId: "internal_twilio_status",
    endpoint: "internal/twilio/status",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Internal Twilio status callback",
    description:
      "Gateway-to-runtime forwarding for Twilio call status updates. Accepts pre-parsed form params as JSON.",
    tags: ["internal"],
    handler: handleInternalStatusCallback,
  },
];
