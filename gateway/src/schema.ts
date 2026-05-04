import packageJson from "../package.json" with { type: "json" };
import {
  TWILIO_CONNECT_ACTION_WEBHOOK_PATH,
  TWILIO_MEDIA_STREAM_WEBHOOK_PATH,
  TWILIO_RELAY_WEBHOOK_PATH,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@vellumai/service-contracts/twilio-ingress";

export function buildSchema(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Vellum Gateway",
      version: packageJson.version,
      description:
        "HTTP gateway that bridges external channels (Telegram, WhatsApp, etc.) to the Vellum assistant runtime and provides an authenticated reverse proxy.",
    },
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness probe",
          operationId: "healthz",
          responses: {
            "200": {
              description: "Gateway is alive",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/readyz": {
        get: {
          summary: "Readiness probe",
          description:
            "Returns 200 when the gateway is ready to accept traffic. Returns 503 during graceful shutdown drain.",
          operationId: "readyz",
          responses: {
            "200": {
              description: "Gateway is ready",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReadyResponse" },
                },
              },
            },
            "503": {
              description:
                "Gateway is draining (graceful shutdown in progress)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DrainingResponse" },
                },
              },
            },
          },
        },
      },
      "/schema": {
        get: {
          summary: "OpenAPI schema",
          description: "Returns the full OpenAPI schema for this gateway.",
          operationId: "getSchema",
          responses: {
            "200": {
              description: "OpenAPI 3.1 schema document",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
      },
      "/v1/health": {
        get: {
          summary: "Runtime health (via gateway)",
          description:
            "Authenticated gateway endpoint that proxies runtime health checks to `/v1/health` on the assistant runtime.",
          operationId: "runtimeHealth",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Runtime health returned",
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Bearer token not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to reach assistant runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "504": {
              description: "Assistant runtime request timed out",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/healthz": {
        get: {
          summary: "Runtime health (via gateway, alias)",
          description:
            "Alias for `/v1/health`. Authenticated gateway endpoint that proxies runtime health checks to `/v1/health` on the assistant runtime.",
          operationId: "runtimeHealthz",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Runtime health returned",
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Bearer token not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to reach assistant runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "504": {
              description: "Assistant runtime request timed out",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/ps": {
        get: {
          summary: "Process status",
          description:
            "Authenticated gateway endpoint that returns a JSON summary of the assistant's process tree. The gateway probes the co-located daemon and reports its own status.",
          operationId: "ps",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Process status returned",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PsResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
          },
        },
      },
      "/v1/brain-graph": {
        get: {
          summary: "Brain graph data",
          description:
            "Authenticated gateway endpoint that retrieves the brain graph data structure from the assistant runtime.",
          operationId: "brainGraph",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Brain graph data returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/brain-graph-ui": {
        get: {
          summary: "Brain graph UI",
          description:
            "Authenticated gateway endpoint that serves the brain graph visualization UI from the assistant runtime.",
          operationId: "brainGraphUI",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Brain graph UI HTML returned",
              content: {
                "text/html": { schema: { type: "string" } },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/webhooks/telegram": {
        post: {
          summary: "Telegram webhook",
          description:
            "Receives inbound Telegram updates, normalizes them, resolves routing, and forwards to the assistant runtime.",
          operationId: "telegramWebhook",
          security: [{ TelegramWebhookSecret: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelegramUpdate" },
              },
            },
          },
          responses: {
            "200": {
              description: "Update accepted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/TelegramOk" },
                },
              },
            },
            "400": {
              description: "Invalid JSON or unreadable body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Webhook secret verification failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed (only POST accepted)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Webhook payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal error processing inbound event",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Telegram integration not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      [TWILIO_VOICE_WEBHOOK_PATH]: {
        post: {
          summary: "Twilio voice webhook",
          description:
            "Receives inbound Twilio voice webhooks, validates the X-Twilio-Signature, and forwards to the assistant runtime.",
          operationId: "twilioVoiceWebhook",
          security: [{ TwilioSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook processed, runtime response forwarded",
            },
            "403": {
              description:
                "Twilio signature validation failed or auth token not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed (only POST accepted)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Webhook payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to forward to runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      [TWILIO_STATUS_WEBHOOK_PATH]: {
        post: {
          summary: "Twilio status webhook",
          description:
            "Receives Twilio call status callbacks, validates the X-Twilio-Signature, and forwards to the assistant runtime.",
          operationId: "twilioStatusWebhook",
          security: [{ TwilioSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Status callback processed",
            },
            "403": {
              description: "Twilio signature validation failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Webhook payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to forward to runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      [TWILIO_CONNECT_ACTION_WEBHOOK_PATH]: {
        post: {
          summary: "Twilio connect-action webhook",
          description:
            "Receives Twilio ConversationRelay connect-action callbacks, validates the X-Twilio-Signature, and forwards to the assistant runtime.",
          operationId: "twilioConnectActionWebhook",
          security: [{ TwilioSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Connect-action callback processed",
            },
            "403": {
              description: "Twilio signature validation failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Webhook payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to forward to runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/webhooks/twilio/voice-verify": {
        post: {
          summary: "Twilio voice verification callback",
          description:
            "Receives DTMF digits from Twilio <Gather> during gateway-owned voice verification. Validates the verification code, creates the guardian binding on success, and returns TwiML to either re-prompt or forward to the assistant for ConversationRelay setup.",
          operationId: "twilioVoiceVerifyCallback",
          security: [{ TwilioSignature: [] }],
          parameters: [
            {
              name: "attempt",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Zero-based attempt counter for retry tracking.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "TwiML response — either a re-prompt <Gather>, a failure <Say>, or forwarded ConversationRelay setup.",
              content: {
                "text/xml": {
                  schema: { type: "string" },
                },
              },
            },
            "403": {
              description: "Twilio signature validation failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/webhooks/whatsapp": {
        get: {
          summary: "WhatsApp webhook verification",
          description:
            "Handles the Meta webhook subscription verification handshake (hub.mode=subscribe). Returns the hub.challenge value as plain text to complete verification.",
          operationId: "whatsappWebhookVerify",
          parameters: [
            {
              name: "hub.mode",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "hub.verify_token",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "hub.challenge",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description:
                "Verification successful — challenge echoed as plain text",
              content: {
                "text/plain": { schema: { type: "string" } },
              },
            },
            "400": {
              description: "Missing parameters",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Verify token mismatch",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        post: {
          summary: "WhatsApp webhook",
          description:
            "Receives inbound WhatsApp Cloud API webhook events, verifies the X-Hub-Signature-256 signature, normalizes text messages, and forwards them to the assistant runtime.",
          operationId: "whatsappWebhook",
          security: [{ WhatsAppHubSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WhatsAppWebhookPayload" },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WhatsAppOk" },
                },
              },
            },
            "400": {
              description: "Invalid JSON or unreadable body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Signature verification failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "WhatsApp integration not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/webhooks/email": {
        post: {
          summary: "Email inbound webhook",
          description:
            "Receives inbound email webhook events from the Vellum platform, verifies the HMAC signature, normalizes the message, and forwards it to the assistant runtime.",
          operationId: "emailInboundWebhook",
          security: [{ VellumSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Vellum email webhook payload.",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
            "400": {
              description: "Invalid JSON or unreadable body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Signature verification failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Webhook secret not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Service temporarily unavailable",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/webhooks/resend": {
        post: {
          summary: "Resend inbound webhook",
          description:
            "Receives inbound email events from Resend (BYO), verifies the Svix signature, fetches the email content from the Resend API, normalizes the message, and forwards it to the assistant runtime.",
          operationId: "resendInboundWebhook",
          security: [{ SvixSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Resend webhook event payload.",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
            "400": {
              description: "Invalid JSON or unreadable body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Signature verification failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Webhook secret not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/webhooks/mailgun": {
        post: {
          summary: "Mailgun BYO inbound webhook",
          description:
            "Receives inbound email events from a BYO Mailgun route forward() action, verifies the HMAC-SHA256 signature using the webhook signing key, normalizes the message, and forwards it to the assistant runtime.",
          operationId: "mailgunInboundWebhook",
          security: [{ MailgunSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  description:
                    "Mailgun inbound route forward payload (form-encoded).",
                },
              },
              "multipart/form-data": {
                schema: {
                  type: "object",
                  description:
                    "Mailgun inbound route forward payload (multipart, when attachments are present).",
                },
              },
              "application/json": {
                schema: {
                  type: "object",
                  description: "Mailgun webhook payload (JSON).",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
            "400": {
              description: "Invalid or unparseable body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Signature verification failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "405": {
              description: "Method not allowed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "Webhook signing key not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "413": {
              description: "Payload too large",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Internal error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/audio/{audioId}": {
        get: {
          summary: "Retrieve synthesized audio",
          description:
            "Serves a previously synthesized TTS audio segment. Unauthenticated — the audioId is an unguessable UUID that acts as a capability token. Used by Twilio to fetch audio for playback during voice calls.",
          operationId: "getAudio",
          parameters: [
            {
              name: "audioId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
              description: "Unique identifier of the audio segment",
            },
          ],
          responses: {
            "200": {
              description: "Audio content",
              content: {
                "audio/*": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "404": {
              description: "Audio not found or expired",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to reach upstream runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "504": {
              description: "Upstream runtime timed out",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      [TWILIO_RELAY_WEBHOOK_PATH]: {
        get: {
          summary: "Twilio ConversationRelay WebSocket",
          description:
            "Accepts a WebSocket upgrade from Twilio ConversationRelay and bidirectionally proxies frames to the assistant runtime's /v1/calls/relay endpoint. Requires a callSessionId query parameter.",
          operationId: "twilioRelayWebsocket",
          parameters: [
            {
              name: "callSessionId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description:
                "Call session identifier used to correlate the WebSocket connection with the runtime relay session.",
            },
          ],
          responses: {
            "101": {
              description:
                "WebSocket upgrade successful — bidirectional frame proxying begins.",
            },
            "400": {
              description: "Missing callSessionId query parameter",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "500": {
              description: "WebSocket upgrade failed",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      [TWILIO_MEDIA_STREAM_WEBHOOK_PATH]: {
        get: {
          summary: "Twilio Media Stream WebSocket",
          description:
            "Accepts a WebSocket upgrade from Twilio Media Streams and bidirectionally proxies frames to the assistant runtime's /v1/calls/media-stream endpoint. Handshake metadata (callSessionId and auth token) is carried in URL path segments (e.g. /webhooks/twilio/media-stream/<callSessionId>/<token>) because Twilio Media Streams does not reliably preserve query parameters across the WebSocket upgrade. Legacy query-parameter-based handshake is still supported as a fallback.",
          operationId: "twilioMediaStreamWebsocket",
          parameters: [
            {
              name: "callSessionId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Call session identifier (legacy fallback). The primary transport encodes callSessionId as a URL path segment: /webhooks/twilio/media-stream/<callSessionId>/<token>.",
            },
          ],
          responses: {
            "101": {
              description:
                "WebSocket upgrade successful — bidirectional media-stream frame proxying begins.",
            },
            "400": {
              description: "Missing callSessionId query parameter",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid token",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "500": {
              description: "WebSocket upgrade failed",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/v1/stt/stream": {
        get: {
          summary: "STT stream WebSocket",
          description:
            "Accepts a WebSocket upgrade for real-time speech-to-text streaming. Authenticates the client using an edge JWT (actor principal) and proxies audio frames bidirectionally to the assistant runtime's /v1/stt/stream endpoint using a gateway service token. Requires mimeType query parameter. The runtime is config-authoritative: the streaming transcriber is always resolved from `services.stt.provider` in the assistant config, not from the optional `provider` query parameter.",
          operationId: "sttStreamWebsocket",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "provider",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Optional STT provider identifier (e.g. 'deepgram', 'google-gemini'). Forwarded as compatibility metadata — the runtime resolves the transcriber from config (`services.stt.provider`), not from this parameter. When supplied and it disagrees with the configured provider, the runtime logs a mismatch warning.",
            },
            {
              name: "mimeType",
              in: "query",
              required: true,
              schema: { type: "string" },
              description:
                "MIME type of the audio being streamed (e.g. 'audio/webm;codecs=opus').",
            },
            {
              name: "sampleRate",
              in: "query",
              required: false,
              schema: { type: "integer" },
              description: "Audio sample rate in Hz, when applicable.",
            },
            {
              name: "token",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Edge JWT for authentication (alternative to Authorization header, since browser WebSocket upgrades cannot set custom headers).",
            },
          ],
          responses: {
            "101": {
              description:
                "WebSocket upgrade successful — bidirectional STT audio/transcription frame proxying begins.",
            },
            "400": {
              description: "Missing required query parameter (mimeType)",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid token",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "426": {
              description:
                "Upgrade Required — request is not a WebSocket upgrade",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "500": {
              description: "WebSocket upgrade failed",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/v1/live-voice": {
        get: {
          summary: "Live voice WebSocket",
          description:
            "Accepts a WebSocket upgrade for the live voice channel. Authenticates the client using an edge JWT (actor principal), opens an upstream assistant WebSocket at /v1/live-voice using a gateway service token, and proxies text and binary audio frames opaquely in both directions.",
          operationId: "liveVoiceWebsocket",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "token",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Edge JWT for authentication (alternative to Authorization header, since browser WebSocket upgrades cannot set custom headers).",
            },
          ],
          responses: {
            "101": {
              description:
                "WebSocket upgrade successful; bidirectional live voice frame proxying begins.",
            },
            "401": {
              description: "Unauthorized - missing or invalid token",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "426": {
              description:
                "Upgrade Required - request is not a WebSocket upgrade",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "500": {
              description: "WebSocket upgrade failed",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/webhooks/oauth/callback": {
        get: {
          summary: "OAuth2 callback",
          description:
            "Receives OAuth2 authorization code callbacks from external providers (Google, Slack, etc.). Forwards the authorization code and state parameter to the assistant runtime for token exchange. Returns an HTML success or error page to the user's browser.",
          operationId: "oauthCallback",
          parameters: [
            {
              name: "state",
              in: "query",
              required: true,
              schema: { type: "string" },
              description:
                "Opaque state parameter used to correlate the callback with the original OAuth flow.",
            },
            {
              name: "code",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Authorization code returned by the OAuth provider on success.",
            },
            {
              name: "error",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Error code returned by the OAuth provider on failure.",
            },
          ],
          responses: {
            "200": {
              description: "Authorization successful — HTML page rendered",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            "400": {
              description:
                "Missing state parameter or authorization failed — HTML error page rendered",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            "502": {
              description:
                "Failed to forward callback to assistant runtime — HTML error page rendered",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/v1/integrations/telegram/config": {
        get: {
          summary: "Get Telegram integration config",
          description:
            "Authenticated gateway endpoint that forwards Telegram integration config reads to the assistant runtime.",
          operationId: "telegramConfigGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Telegram config returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        post: {
          summary: "Set Telegram integration config",
          description:
            "Authenticated gateway endpoint that forwards Telegram integration config writes to the assistant runtime.",
          operationId: "telegramConfigPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Telegram config updated" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        delete: {
          summary: "Clear Telegram integration config",
          description:
            "Authenticated gateway endpoint that clears Telegram integration config via the assistant runtime.",
          operationId: "telegramConfigDelete",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Telegram config cleared" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/telegram/commands": {
        post: {
          summary: "Set Telegram commands",
          description:
            "Authenticated gateway endpoint that forwards Telegram command registration to the assistant runtime.",
          operationId: "telegramCommandsPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Telegram commands updated" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/telegram/setup": {
        post: {
          summary: "Run Telegram setup",
          description:
            "Authenticated gateway endpoint that forwards Telegram setup orchestration to the assistant runtime.",
          operationId: "telegramSetupPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Telegram setup completed" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/vercel/config": {
        get: {
          summary: "Get Vercel integration config",
          description:
            "Authenticated gateway endpoint that checks whether a Vercel API token is stored in the credential vault.",
          operationId: "vercelConfigGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Vercel config returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        post: {
          summary: "Set or delete Vercel integration config",
          description:
            "Authenticated gateway endpoint that stores or deletes a Vercel API token via the assistant runtime. The action field in the request body determines the operation.",
          operationId: "vercelConfigPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Vercel config updated" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        delete: {
          summary: "Delete Vercel integration config",
          description:
            "Authenticated gateway endpoint that deletes the Vercel API token via the assistant runtime.",
          operationId: "vercelConfigDelete",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Vercel config deleted" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts": {
        get: {
          summary: "List or search contacts",
          description:
            "Authenticated gateway endpoint that lists or searches contacts via the assistant runtime.",
          operationId: "contactsGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Contacts returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        post: {
          summary: "Create or update a contact",
          description:
            "Authenticated gateway endpoint that creates or updates a contact via the assistant runtime.",
          operationId: "contactsPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contact updated" },
            "201": { description: "Contact created" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/merge": {
        post: {
          summary: "Merge two contacts",
          description:
            "Authenticated gateway endpoint that merges two contacts via the assistant runtime.",
          operationId: "contactsMergePost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contacts merged" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/prompt/submit": {
        post: {
          summary: "Submit a contact address in response to a prompt",
          description:
            "Authenticated gateway endpoint that accepts a contact address submitted by the user in response to a contacts/prompt IPC request. Writes the contact, notifies the daemon to unblock the waiting CLI call.",
          operationId: "contactsPromptSubmitPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contact created and prompt resolved" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "409": { description: "Channel already exists for this contact" },
            "503": { description: "Bearer token not configured" },
          },
        },
      },
      "/v1/contact-channels/{contactChannelId}": {
        patch: {
          summary: "Update a contact channel",
          description:
            "Authenticated gateway endpoint that updates a contact channel's status or policy via the assistant runtime.",
          operationId: "contactsChannelPatch",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "contactChannelId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contact channel updated" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "Channel not found" },
            "409": {
              description:
                "Invalid state transition (e.g. revoking a blocked channel)",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/{contactId}": {
        get: {
          summary: "Get a contact by ID",
          description:
            "Authenticated gateway endpoint that retrieves a contact by ID via the assistant runtime.",
          operationId: "contactsGetById",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "contactId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Contact returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "Contact not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        delete: {
          summary: "Delete a contact by ID",
          description:
            "Authenticated gateway endpoint that deletes a contact by ID via the assistant runtime.",
          operationId: "contactsDeleteById",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "contactId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "204": { description: "Contact deleted" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Contact cannot be deleted" },
            "404": { description: "Contact not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/invites": {
        get: {
          summary: "List contacts invites",
          description:
            "Authenticated gateway endpoint that lists contacts invites via the assistant runtime.",
          operationId: "contactsInvitesGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Contacts invites returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        post: {
          summary: "Create contacts invite",
          description:
            "Authenticated gateway endpoint that creates a contacts invite via the assistant runtime.",
          operationId: "contactsInvitesPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contacts invite created" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/invites/redeem": {
        post: {
          summary: "Redeem contacts invite",
          description:
            "Authenticated gateway endpoint that redeems a contacts invite via the assistant runtime.",
          operationId: "contactsInvitesRedeemPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Contacts invite redeemed" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "Invite not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/invites/{inviteId}/call": {
        post: {
          summary: "Call a contacts invite",
          description:
            "Authenticated gateway endpoint that initiates a call for a contacts invite via the assistant runtime.",
          operationId: "contactsInvitesCallPost",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "inviteId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Invite call initiated" },
            "400": {
              description:
                "Bad request — invite not found or validation failure",
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "Invite not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/contacts/invites/{inviteId}": {
        delete: {
          summary: "Revoke contacts invite",
          description:
            "Authenticated gateway endpoint that revokes a contacts invite via the assistant runtime.",
          operationId: "contactsInvitesDelete",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "inviteId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Contacts invite revoked" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "Invite not found or already revoked" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/channel-verification-sessions": {
        post: {
          summary: "Create channel verification session",
          description:
            "Create a channel verification session (inbound challenge or outbound verification).",
          operationId: "verificationSessionCreate",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "purpose",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Optional verification purpose (e.g. guardian, trusted-contact).",
            },
            {
              name: "contactChannelId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Optional contact channel ID to verify.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Session created" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "429": { description: "Rate limited by verification policy" },
            "502": { description: "Failed to reach assistant runtime" },
            "503": { description: "Bearer token not configured" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        delete: {
          summary: "Cancel channel verification session",
          description: "Cancel the active channel verification session.",
          operationId: "verificationSessionCancel",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Session cancelled" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant runtime" },
            "503": { description: "Bearer token not configured" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/channel-verification-sessions/resend": {
        post: {
          summary: "Resend verification code",
          description: "Resend the outbound verification code.",
          operationId: "verificationSessionResend",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Verification code resent" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "429": { description: "Rate limited by verification policy" },
            "502": { description: "Failed to reach assistant runtime" },
            "503": { description: "Bearer token not configured" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/channel-verification-sessions/status": {
        get: {
          summary: "Get verification binding status",
          description:
            "Authenticated gateway endpoint that forwards verification status checks to the assistant runtime.",
          operationId: "verificationStatus",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "channel",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["phone", "telegram"] },
              description: "Optional channel filter.",
            },
          ],
          responses: {
            "200": { description: "Verification status returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/guardian/init": {
        post: {
          summary: "Initialize guardian",
          description:
            "Authenticated gateway endpoint that initializes the guardian identity and binds it to the assistant runtime.",
          operationId: "guardianInit",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Guardian initialized" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/guardian/reset-bootstrap": {
        post: {
          summary: "Reset guardian bootstrap lock",
          description:
            "Loopback-only, bare-metal-only endpoint that removes the guardian-init lock file so that /v1/guardian/init can be called again. Used by the desktop app to recover from a lost actor token.",
          operationId: "guardianResetBootstrap",
          responses: {
            "200": { description: "Lock file removed (or already absent)" },
            "403": {
              description:
                "Forbidden — non-loopback origin or containerized mode",
            },
            "409": {
              description: "Guardian init is in progress — try again shortly",
            },
            "500": { description: "Failed to remove lock file" },
          },
        },
      },
      "/v1/channel-verification-sessions/revoke": {
        post: {
          summary: "Revoke verification binding",
          description:
            "Authenticated gateway endpoint that revokes an existing verification binding via the assistant runtime.",
          operationId: "verificationRevoke",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Verification binding revoked" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/guardian/refresh": {
        post: {
          summary: "Refresh guardian access token",
          description:
            "Refreshes an expired guardian access token. Accepts expired JWTs (signature, audience, and policy epoch are still verified — only the expiration check is relaxed).",
          operationId: "guardianRefresh",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "New access token returned" },
            "401": { description: "Unauthorized — invalid token" },
            "502": { description: "Failed to reach assistant runtime" },
          },
        },
      },
      "/v1/integrations/twilio/config": {
        get: {
          summary: "Get Twilio integration config",
          description:
            "Authenticated gateway endpoint that returns current Twilio integration configuration from the assistant runtime.",
          operationId: "twilioConfigGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Twilio config returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/twilio/credentials": {
        post: {
          summary: "Set Twilio credentials",
          description:
            "Authenticated gateway endpoint that stores Twilio account credentials via the assistant runtime.",
          operationId: "twilioCredentialsPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Twilio credentials stored" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        delete: {
          summary: "Clear Twilio credentials",
          description:
            "Authenticated gateway endpoint that clears stored Twilio credentials via the assistant runtime.",
          operationId: "twilioCredentialsDelete",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Twilio credentials cleared" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/twilio/numbers": {
        get: {
          summary: "List Twilio phone numbers",
          description:
            "Authenticated gateway endpoint that lists available Twilio phone numbers via the assistant runtime.",
          operationId: "twilioNumbersGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Twilio phone numbers returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/twilio/numbers/provision": {
        post: {
          summary: "Provision a Twilio phone number",
          description:
            "Authenticated gateway endpoint that provisions a new Twilio phone number via the assistant runtime.",
          operationId: "twilioNumbersProvisionPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Phone number provisioned" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/twilio/numbers/assign": {
        post: {
          summary: "Assign a Twilio phone number",
          description:
            "Authenticated gateway endpoint that assigns an existing Twilio phone number to the assistant via the runtime.",
          operationId: "twilioNumbersAssignPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Phone number assigned" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/integrations/twilio/numbers/release": {
        post: {
          summary: "Release a Twilio phone number",
          description:
            "Authenticated gateway endpoint that releases an assigned Twilio phone number via the assistant runtime.",
          operationId: "twilioNumbersReleasePost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Phone number released" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/slack/channels": {
        get: {
          summary: "List Slack channels",
          description:
            "Authenticated gateway endpoint that lists available Slack channels by proxying to the assistant runtime. Returns all channels in a single response.",
          operationId: "slackChannelsGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Slack channels returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/slack/share": {
        post: {
          summary: "Share to Slack",
          description:
            "Authenticated gateway endpoint that shares content to a Slack channel by proxying to the assistant runtime.",
          operationId: "slackSharePost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Content shared to Slack" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/providers": {
        get: {
          summary: "List OAuth providers",
          description:
            "Authenticated gateway endpoint that lists available OAuth providers by proxying to the assistant runtime.",
          operationId: "oauthProvidersList",
          parameters: [
            {
              name: "supports_managed_mode",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description:
                "When true, only return providers that support managed mode.",
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth providers returned",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/providers/{providerKey}": {
        get: {
          summary: "Get OAuth provider",
          description:
            "Authenticated gateway endpoint that retrieves a single OAuth provider by key by proxying to the assistant runtime.",
          operationId: "oauthProvidersGet",
          parameters: [
            {
              name: "providerKey",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The provider key, for example `google`.",
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth provider returned",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth provider not found" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/apps": {
        get: {
          summary: "List OAuth apps",
          description:
            "Authenticated gateway endpoint that lists configured OAuth apps for a provider by proxying to the assistant runtime.",
          operationId: "oauthAppsList",
          parameters: [
            {
              name: "provider_key",
              in: "query",
              required: true,
              schema: { type: "string" },
              description:
                "OAuth provider key to filter by, for example `google`.",
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth apps returned",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/OAuthAppListResponse",
                  },
                },
              },
            },
            "400": {
              description: "Missing or invalid provider_key query parameter",
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
        post: {
          summary: "Create OAuth app",
          description:
            "Authenticated gateway endpoint that creates or updates a user-managed OAuth app by proxying to the assistant runtime.",
          operationId: "oauthAppsCreate",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OAuthAppCreateRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "OAuth app created",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/OAuthAppCreateResponse",
                  },
                },
              },
            },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth provider not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/apps/{appId}": {
        delete: {
          summary: "Delete OAuth app",
          description:
            "Authenticated gateway endpoint that deletes a user-managed OAuth app and disconnects its linked accounts by proxying to the assistant runtime.",
          operationId: "oauthAppsDelete",
          parameters: [
            {
              name: "appId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth app deleted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/OkResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth app not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/apps/{appId}/connections": {
        get: {
          summary: "List OAuth app connections",
          description:
            "Authenticated gateway endpoint that lists linked accounts for a specific OAuth app by proxying to the assistant runtime.",
          operationId: "oauthAppConnectionsList",
          parameters: [
            {
              name: "appId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth app connections returned",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/OAuthConnectionListResponse",
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth app not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/connections/{connectionId}": {
        delete: {
          summary: "Delete OAuth connection",
          description:
            "Authenticated gateway endpoint that disconnects a linked OAuth account by proxying to the assistant runtime.",
          operationId: "oauthConnectionDelete",
          parameters: [
            {
              name: "connectionId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "OAuth connection deleted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/OkResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth connection not found" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/oauth/apps/{appId}/connect": {
        post: {
          summary: "Start OAuth app connect flow",
          description:
            "Authenticated gateway endpoint that starts an OAuth authorization flow for a specific app by proxying to the assistant runtime.",
          operationId: "oauthAppConnect",
          parameters: [
            {
              name: "appId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OAuthConnectRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "OAuth connect flow started",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/OAuthConnectResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": { description: "OAuth app not found" },
            "500": { description: "Failed to start OAuth flow" },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/channels/readiness": {
        get: {
          summary: "Get channel readiness",
          description:
            "Authenticated gateway endpoint that returns the readiness status of all configured channels from the assistant runtime.",
          operationId: "channelReadinessGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Channel readiness status returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/assistants/{assistantId}/channels/readiness/": {
        get: {
          summary: "Get channel readiness (scoped)",
          description:
            "Authenticated gateway endpoint that returns the readiness status of all configured channels from the assistant runtime. The assistantId path segment is used for routing but does not affect the response.",
          operationId: "channelReadinessScopedGet",
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Channel readiness status returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/channels/readiness/refresh": {
        post: {
          summary: "Refresh channel readiness",
          description:
            "Authenticated gateway endpoint that triggers a fresh readiness check for all channels via the assistant runtime.",
          operationId: "channelReadinessRefreshPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Channel readiness refreshed" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "503": { description: "Bearer token not configured" },
            "502": { description: "Failed to reach assistant runtime" },
            "504": { description: "Assistant runtime request timed out" },
          },
        },
      },
      "/v1/feature-flags": {
        get: {
          summary: "List feature flags",
          description:
            "Scope-protected gateway endpoint that lists current feature flag values. Requires a bearer token with `feature_flags.read` scope.",
          operationId: "featureFlagsGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": { description: "Feature flags returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/v1/feature-flags/{flagKey}": {
        patch: {
          summary: "Update a feature flag",
          description:
            "Scope-protected gateway endpoint that updates a single feature flag value. Requires a bearer token with `feature_flags.write` scope.",
          operationId: "featureFlagsPatch",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "flagKey",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The feature flag key to update.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Feature flag updated" },
            "400": { description: "Invalid flag key encoding" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/v1/config/privacy": {
        get: {
          summary: "Get privacy config",
          description:
            "Scope-protected gateway endpoint that returns the current privacy configuration (collectUsageData, sendDiagnostics, llmRequestLogRetentionMs). Missing or malformed values fall back to the daemon schema defaults. Requires a bearer token with `settings.read` scope.",
          operationId: "privacyConfigGet",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Privacy config returned",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collectUsageData: { type: "boolean" },
                      sendDiagnostics: { type: "boolean" },
                      llmRequestLogRetentionMs: {
                        type: ["integer", "null"],
                        minimum: 0,
                        maximum: 31536000000,
                        description:
                          "Retention period for LLM request/response logs in milliseconds. null keeps forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms); server-side clamping enforces this cap on reads.",
                      },
                    },
                    required: [
                      "collectUsageData",
                      "sendDiagnostics",
                      "llmRequestLogRetentionMs",
                    ],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "500": { description: "Config file is malformed" },
          },
        },
        patch: {
          summary: "Update privacy config",
          description:
            "Scope-protected gateway endpoint that updates privacy configuration (collectUsageData, sendDiagnostics, llmRequestLogRetentionMs). Requires a bearer token with `settings.write` scope.",
          operationId: "privacyConfigPatch",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    collectUsageData: { type: "boolean" },
                    sendDiagnostics: { type: "boolean" },
                    llmRequestLogRetentionMs: {
                      type: ["integer", "null"],
                      minimum: 0,
                      maximum: 31536000000,
                      description:
                        "Retention window for LLM request logs, in milliseconds. null keeps forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms).",
                    },
                  },
                  anyOf: [
                    { required: ["collectUsageData"] },
                    { required: ["sendDiagnostics"] },
                    { required: ["llmRequestLogRetentionMs"] },
                  ],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Privacy config updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collectUsageData: { type: "boolean" },
                      sendDiagnostics: { type: "boolean" },
                      llmRequestLogRetentionMs: {
                        type: ["integer", "null"],
                        minimum: 0,
                        maximum: 31536000000,
                        description:
                          "Retention window for LLM request logs, in milliseconds. null keeps logs forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms).",
                      },
                    },
                    required: [
                      "collectUsageData",
                      "sendDiagnostics",
                      "llmRequestLogRetentionMs",
                    ],
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/assistants/{assistantId}/feature-flags": {
        get: {
          summary: "List feature flags (assistant-scoped)",
          description:
            "Assistant-scoped variant of the feature flags endpoint. Requires a bearer token with `feature_flags.read` scope.",
          operationId: "assistantFeatureFlagsGet",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The assistant identifier.",
            },
          ],
          responses: {
            "200": { description: "Feature flags returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/v1/assistants/{assistantId}/feature-flags/{flagKey}": {
        patch: {
          summary: "Update a feature flag (assistant-scoped)",
          description:
            "Assistant-scoped variant of the feature flag update endpoint. Requires a bearer token with `feature_flags.write` scope.",
          operationId: "assistantFeatureFlagsPatch",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The assistant identifier.",
            },
            {
              name: "flagKey",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The feature flag key to update.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Feature flag updated" },
            "400": { description: "Invalid flag key encoding" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/v1/assistants/{assistantId}/config/privacy/": {
        get: {
          summary: "Get privacy config (assistant-scoped)",
          description:
            "Assistant-scoped variant of the privacy config read endpoint. Returns the current privacy configuration (collectUsageData, sendDiagnostics, llmRequestLogRetentionMs). Missing or malformed values fall back to the daemon schema defaults. Requires a bearer token with `settings.read` scope.",
          operationId: "assistantPrivacyConfigGet",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The assistant identifier.",
            },
          ],
          responses: {
            "200": {
              description: "Privacy config returned",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collectUsageData: { type: "boolean" },
                      sendDiagnostics: { type: "boolean" },
                      llmRequestLogRetentionMs: {
                        type: ["integer", "null"],
                        minimum: 0,
                        maximum: 31536000000,
                        description:
                          "Retention period for LLM request/response logs in milliseconds. null keeps forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms); server-side clamping enforces this cap on reads.",
                      },
                    },
                    required: [
                      "collectUsageData",
                      "sendDiagnostics",
                      "llmRequestLogRetentionMs",
                    ],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "500": { description: "Config file is malformed" },
          },
        },
        patch: {
          summary: "Update privacy config (assistant-scoped)",
          description:
            "Assistant-scoped variant of the privacy config endpoint. Requires a bearer token with `settings.write` scope.",
          operationId: "assistantPrivacyConfigPatch",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The assistant identifier.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    collectUsageData: { type: "boolean" },
                    sendDiagnostics: { type: "boolean" },
                    llmRequestLogRetentionMs: {
                      type: ["integer", "null"],
                      minimum: 0,
                      maximum: 31536000000,
                      description:
                        "Retention window for LLM request logs, in milliseconds. null keeps forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms).",
                    },
                  },
                  anyOf: [
                    { required: ["collectUsageData"] },
                    { required: ["sendDiagnostics"] },
                    { required: ["llmRequestLogRetentionMs"] },
                  ],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Privacy config updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collectUsageData: { type: "boolean" },
                      sendDiagnostics: { type: "boolean" },
                      llmRequestLogRetentionMs: {
                        type: ["integer", "null"],
                        minimum: 0,
                        maximum: 31536000000,
                        description:
                          "Retention window for LLM request logs, in milliseconds. null keeps logs forever, 0 prunes immediately. Maximum is 365 days (31536000000 ms).",
                      },
                    },
                    required: [
                      "collectUsageData",
                      "sendDiagnostics",
                      "llmRequestLogRetentionMs",
                    ],
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/permissions/thresholds": {
        get: {
          summary: "Get global auto-approve thresholds",
          operationId: "globalThresholdGet",
          security: [{ EdgeScoped: [] }],
          responses: {
            "200": {
              description: "Current thresholds",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      interactive: { type: "string" },
                      autonomous: { type: "string" },
                      headless: { type: "string" },
                    },
                  },
                },
              },
            },
            "500": { description: "Internal server error" },
          },
        },
        put: {
          summary: "Upsert global auto-approve thresholds",
          operationId: "globalThresholdPut",
          security: [{ EdgeScoped: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    interactive: { type: "string" },
                    autonomous: { type: "string" },
                    headless: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated thresholds",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      interactive: { type: "string" },
                      autonomous: { type: "string" },
                      headless: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/assistants/{assistantId}/permissions/thresholds": {
        get: {
          summary: "Get global auto-approve thresholds (assistant-scoped)",
          operationId: "globalThresholdGetScoped",
          security: [{ EdgeScoped: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Current thresholds",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      interactive: { type: "string" },
                      autonomous: { type: "string" },
                      headless: { type: "string" },
                    },
                  },
                },
              },
            },
            "500": { description: "Internal server error" },
          },
        },
        put: {
          summary: "Upsert global auto-approve thresholds (assistant-scoped)",
          operationId: "globalThresholdPutScoped",
          security: [{ EdgeScoped: [] }],
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    interactive: { type: "string" },
                    autonomous: { type: "string" },
                    headless: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated thresholds",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      interactive: { type: "string" },
                      autonomous: { type: "string" },
                      headless: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/permissions/thresholds/conversations/{conversationId}": {
        get: {
          summary: "Get per-conversation threshold override",
          operationId: "conversationThresholdGet",
          security: [{ EdgeScoped: [] }],
          parameters: [
            {
              name: "conversationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Conversation threshold override",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { threshold: { type: "string" } },
                  },
                },
              },
            },
            "404": { description: "No override for this conversation" },
            "500": { description: "Internal server error" },
          },
        },
        put: {
          summary: "Upsert per-conversation threshold override",
          operationId: "conversationThresholdPut",
          security: [{ EdgeScoped: [] }],
          parameters: [
            {
              name: "conversationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { threshold: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated override",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      conversationId: { type: "string" },
                      threshold: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request body" },
            "500": { description: "Internal server error" },
          },
        },
        delete: {
          summary: "Delete per-conversation threshold override",
          operationId: "conversationThresholdDelete",
          security: [{ EdgeScoped: [] }],
          parameters: [
            {
              name: "conversationId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "204": { description: "Override deleted" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/assistants/{assistantId}/permissions/thresholds/conversations/{conversationId}":
        {
          get: {
            summary:
              "Get per-conversation threshold override (assistant-scoped)",
            operationId: "conversationThresholdGetScoped",
            security: [{ EdgeScoped: [] }],
            parameters: [
              {
                name: "assistantId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "conversationId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Conversation threshold override",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { threshold: { type: "string" } },
                    },
                  },
                },
              },
              "404": { description: "No override for this conversation" },
              "500": { description: "Internal server error" },
            },
          },
          put: {
            summary:
              "Upsert per-conversation threshold override (assistant-scoped)",
            operationId: "conversationThresholdPutScoped",
            security: [{ EdgeScoped: [] }],
            parameters: [
              {
                name: "assistantId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "conversationId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { threshold: { type: "string" } },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Updated override",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        conversationId: { type: "string" },
                        threshold: { type: "string" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Invalid request body" },
              "500": { description: "Internal server error" },
            },
          },
          delete: {
            summary:
              "Delete per-conversation threshold override (assistant-scoped)",
            operationId: "conversationThresholdDeleteScoped",
            security: [{ EdgeScoped: [] }],
            parameters: [
              {
                name: "assistantId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "conversationId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "204": { description: "Override deleted" },
              "500": { description: "Internal server error" },
            },
          },
        },
      "/v1/logs/export": {
        post: {
          summary: "Export logs from all services",
          description:
            "Orchestrates parallel log collection from the gateway, daemon, and CES, " +
            "returning a tar.gz archive containing logs from all three services.",
          operationId: "logsExport",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    startTime: {
                      type: "number",
                      description: "Start of time range (epoch ms)",
                    },
                    endTime: {
                      type: "number",
                      description: "End of time range (epoch ms)",
                    },
                    auditLimit: {
                      type: "number",
                      description: "Maximum number of audit records to include",
                    },
                    conversationId: {
                      type: "string",
                      description: "Scope export to a specific conversation",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "tar.gz archive of collected logs",
              content: {
                "application/gzip": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "400": { description: "Invalid JSON body" },
            "401": {
              description: "Unauthorized — missing or invalid edge JWT",
            },
            "500": { description: "Failed to create export archive" },
          },
        },
      },
      "/v1/logs/tail": {
        get: {
          summary: "Tail gateway log entries",
          description:
            "Returns the last N structured log entries from the gateway's pino log files, " +
            "with optional filtering by minimum level and module name.",
          operationId: "gatewayLogsTail",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "n",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 1000, default: 10 },
              description: "Number of log entries to return (1–1000, default: 10)",
            },
            {
              name: "level",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["trace", "debug", "info", "warn", "error", "fatal"],
                default: "info",
              },
              description: "Minimum pino level name (default: info)",
            },
            {
              name: "module",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter to exact pino module name",
            },
          ],
          responses: {
            "200": {
              description: "Log entries and truncation flag",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["lines", "truncated"],
                    properties: {
                      lines: {
                        type: "array",
                        items: { type: "object" },
                        description: "Matching log entries in chronological order",
                      },
                      truncated: {
                        type: "boolean",
                        description: "True if earlier matching entries exist beyond n",
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid level parameter" },
            "401": {
              description: "Unauthorized — missing or invalid edge JWT",
            },
          },
        },
      },
      "/v1/trust-rules": {
        get: {
          summary: "List trust rules",
          description:
            "Authenticated gateway endpoint that lists trust rules from the SQLite-backed store. By default returns user-relevant rules (user_defined + user-modified defaults). Supports `origin`, `tool`, and `include_deleted` query filters.",
          operationId: "trustRulesGet",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "origin",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["default", "user_defined"] },
              description: "Filter by rule origin.",
            },
            {
              name: "tool",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by tool name.",
            },
            {
              name: "include_deleted",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "Include soft-deleted rules in the response.",
            },
          ],
          responses: {
            "200": { description: "Trust rules returned" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "500": { description: "Internal server error" },
          },
        },
        post: {
          summary: "Create a trust rule",
          description:
            "Authenticated gateway endpoint that creates a user-defined trust rule in the SQLite-backed store. Gated behind the `permission-controls` feature flag.",
          operationId: "trustRulesPost",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "201": { description: "Trust rule created" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Feature not enabled" },
          },
        },
      },
      "/v1/trust-rules/suggest": {
        post: {
          summary: "Suggest a trust rule",
          description:
            "Authenticated gateway endpoint that calls the assistant daemon to generate an LLM-powered trust rule suggestion for a given command invocation. Gated behind the `permission-controls` feature flag.",
          operationId: "trustRulesSuggest",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Trust rule suggestion returned" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Feature not enabled" },
            "503": {
              description: "Assistant daemon unavailable or LLM failure",
            },
          },
        },
      },
      "/v1/trust-rules/{ruleId}": {
        patch: {
          summary: "Update a trust rule",
          description:
            "Authenticated gateway endpoint that updates a trust rule's risk and/or description. Default rules are marked `userModified=true` on change. Gated behind the `permission-controls` feature flag.",
          operationId: "trustRulesPatch",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "ruleId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Trust rule updated" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Feature not enabled" },
            "404": { description: "Trust rule not found" },
          },
        },
        delete: {
          summary: "Delete a trust rule",
          description:
            "Authenticated gateway endpoint that deletes a trust rule. User-defined rules are hard-deleted; default rules are soft-deleted. Gated behind the `permission-controls` feature flag.",
          operationId: "trustRulesDelete",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "ruleId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Trust rule deleted" },
            "400": { description: "Rule ID is required" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Feature not enabled" },
            "404": { description: "Trust rule not found" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/trust-rules/{ruleId}/reset": {
        post: {
          summary: "Reset a default trust rule",
          description:
            "Authenticated gateway endpoint that resets a modified default trust rule back to its original risk and description from the command registry. Only valid for rules with `origin=default`. Gated behind the `permission-controls` feature flag.",
          operationId: "trustRulesResetPost",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "ruleId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Trust rule reset to defaults" },
            "400": {
              description:
                "Rule is not a default rule, or original values cannot be determined",
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Feature not enabled" },
            "404": { description: "Trust rule not found" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/integrations/status": {
        get: {
          summary: "Integration status",
          description:
            "Returns the current status of configured integrations, including the assistant's email address. Requires a valid bearer token.",
          operationId: "integrationsStatus",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Integration status",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/IntegrationsStatusResponse",
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Bearer token not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/assistants/{assistantId}/integrations/status/": {
        get: {
          summary: "Integration status (scoped)",
          description:
            "Returns the current status of configured integrations, including the assistant's email address. Requires a valid bearer token. The assistantId path segment is used for routing but does not affect the response.",
          operationId: "integrationsStatusScoped",
          parameters: [
            {
              name: "assistantId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Integration status",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/IntegrationsStatusResponse",
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Bearer token not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/admin/upgrade-broadcast": {
        post: {
          summary: "Broadcast upgrade to connected clients",
          description:
            "Internal control-plane endpoint that proxies an upgrade-broadcast request to the assistant daemon. Authenticated with an edge JWT. The daemon notifies all connected clients that a new version is available.",
          operationId: "upgradeBroadcast",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Broadcast sent successfully" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/migrations/export": {
        post: {
          summary: "Export workspace backup",
          description:
            "Proxies a migration export request to the assistant daemon. Returns a binary .vbundle backup of the workspace. Authenticated with an edge JWT. Timeout is 120 seconds to accommodate large workspaces.",
          operationId: "migrationExport",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": {
              description: "Binary .vbundle backup file",
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/migrations/import": {
        post: {
          summary: "Import workspace backup",
          description:
            "Proxies a migration import request to the assistant. Two request shapes are accepted:\n" +
            "\n" +
            "  - `application/octet-stream`: raw .vbundle body. The request is proxied synchronously and the caller's connection stays open for the full import duration (returns 200 on success).\n" +
            '  - `application/json` with `{ "url": "<signed GCS URL>" }`: the gateway generates a jobId, kicks off the upstream assistant call in the background, and returns `202 Accepted` with `{ job_id, status: "pending" }` immediately. Callers poll `GET /v1/migrations/import/{jobId}/status` for progress.\n' +
            "\n" +
            "Authenticated with an edge JWT. Synchronous-path timeout is 60 minutes to accommodate large 8 GB backups; the async path returns immediately.",
          operationId: "migrationImport",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Signed GCS URL pointing at a .vbundle archive.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Backup imported successfully (synchronous byte path).",
            },
            "202": {
              description:
                "Import accepted for async processing (JSON URL path). Poll `/v1/migrations/import/{jobId}/status` for progress.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["job_id", "status"],
                    properties: {
                      job_id: { type: "string" },
                      status: { type: "string", enum: ["pending"] },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/migrations/import/{jobId}/status": {
        get: {
          summary: "Poll async import job status",
          description:
            "Returns the current status of an async `.vbundle` import kicked off by `POST /v1/migrations/import` with a JSON `{url}` body. Finished jobs remain queryable for 30 minutes before being pruned.",
          operationId: "migrationImportStatus",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              in: "path",
              name: "jobId",
              required: true,
              schema: { type: "string" },
              description:
                "The `job_id` returned by the 202 response from `POST /v1/migrations/import`.",
            },
          ],
          responses: {
            "200": {
              description: "Current job status.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["job_id", "status"],
                    properties: {
                      job_id: { type: "string" },
                      status: {
                        type: "string",
                        enum: ["pending", "processing", "complete", "failed"],
                      },
                      error: { type: "string" },
                      result: {},
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": {
              description:
                "Unknown job — never issued, or pruned after 30-minute TTL.",
            },
          },
        },
      },
      "/v1/migrations/export-to-gcs": {
        post: {
          summary: "Kick off an async export-to-GCS job",
          description:
            "Transparent proxy to the assistant daemon's `POST /v1/migrations/export-to-gcs` endpoint. The daemon schedules a background export job that streams the workspace backup to the supplied signed GCS upload URL and returns `202 Accepted` with a `job_id`. Callers poll `GET /v1/migrations/jobs/{jobId}` for progress. Registered explicitly (not via the runtime-proxy catch-all) for dedicated auth and timeout handling.",
          operationId: "migrationExportToGcs",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "202": {
              description: "Export job accepted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["job_id"],
                    properties: { job_id: { type: "string" } },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "409": {
              description: "Another export is already in flight.",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/migrations/import-from-gcs": {
        post: {
          summary: "Kick off an async import-from-GCS job",
          description:
            "Transparent proxy to the assistant daemon's `POST /v1/migrations/import-from-gcs` endpoint. The daemon schedules a background import job that fetches a `.vbundle` archive at the supplied `bundle_url` and streams it through the importer, returning `202 Accepted` with a `job_id`. Callers poll `GET /v1/migrations/jobs/{jobId}` for progress. Registered explicitly (not via the runtime-proxy catch-all) for dedicated auth and timeout handling.",
          operationId: "migrationImportFromGcs",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["bundle_url"],
                  properties: {
                    bundle_url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Signed GCS URL pointing at a .vbundle archive.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Import job accepted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["job_id"],
                    properties: { job_id: { type: "string" } },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "409": {
              description: "Another import is already in flight.",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/migrations/jobs/{jobId}": {
        get: {
          summary: "Poll unified migration job status",
          description:
            "Transparent proxy to the assistant daemon's `GET /v1/migrations/jobs/{job_id}` endpoint. Returns the current status of an async export-to-GCS or import-from-GCS job tracked by the daemon's migration job registry. Registered explicitly (not via the runtime-proxy catch-all) for dedicated auth and timeout handling.",
          operationId: "migrationJobStatus",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              in: "path",
              name: "jobId",
              required: true,
              schema: { type: "string" },
              description:
                "The `job_id` returned by the 202 response from `POST /v1/migrations/export-to-gcs` or `POST /v1/migrations/import-from-gcs`.",
            },
          ],
          responses: {
            "200": {
              description: "Current job status.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["job_id", "type", "status"],
                    properties: {
                      job_id: { type: "string" },
                      type: {
                        type: "string",
                        enum: ["export", "import"],
                      },
                      status: {
                        type: "string",
                        enum: ["processing", "complete", "failed"],
                      },
                      result: {},
                      error: { type: "string" },
                      error_code: { type: "string" },
                      upstream_status: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "404": {
              description: "Unknown job_id.",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/admin/workspace-commit": {
        post: {
          summary: "Commit workspace changes",
          description:
            "Proxies a workspace-commit request to the assistant daemon. Creates a git commit of the current workspace state with the provided message. Authenticated with an edge JWT.",
          operationId: "workspaceCommit",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Workspace commit created successfully" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/v1/admin/rollback-migrations": {
        post: {
          summary: "Rollback database and workspace migrations",
          description:
            "Proxies a rollback-migrations request to the assistant daemon. Rolls back database and workspace migrations to a specified target version. Authenticated with an edge JWT.",
          operationId: "rollbackMigrations",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Migrations rolled back successfully" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant daemon" },
            "504": { description: "Assistant daemon request timed out" },
          },
        },
      },
      "/inbound/register": {
        post: {
          summary: "Auto-verify guardian email (BYO provider)",
          description:
            "Called by the platform after registering a BYO email provider webhook. Validates the provider API key, cross-checks the guardian email (when provider supports it), and creates a guardian email channel binding.",
          operationId: "inboundRegister",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["type", "guardian_email"],
                  properties: {
                    type: {
                      type: "string",
                      description: "Email provider type (e.g. resend, mailgun)",
                    },
                    guardian_email: {
                      type: "string",
                      format: "email",
                      description: "Guardian email address to verify",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Guardian email channel verified and binding created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      verified_via: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid request body or unsupported provider type",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "No guardian contact exists",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "409": {
              description: "No API key configured for provider",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "422": {
              description: "Email validation failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description: "Failed to create guardian binding",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/v1/backups": {
        get: {
          summary: "List backup snapshots",
          description:
            "Lists local and offsite backup snapshots. The gateway owns the backup encryption key and performs all encrypt/decrypt operations.",
          operationId: "backupsList",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Backup snapshots listed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["local", "offsite"],
                    properties: {
                      local: {
                        type: "object",
                        required: ["directory", "snapshots"],
                        properties: {
                          directory: { type: "string" },
                          snapshots: {
                            type: "array",
                            items: {
                              $ref: "#/components/schemas/BackupSnapshot",
                            },
                          },
                        },
                      },
                      offsite: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["directory", "encrypted", "snapshots"],
                          properties: {
                            directory: { type: "string" },
                            encrypted: { type: "boolean" },
                            snapshots: {
                              type: "array",
                              items: {
                                $ref: "#/components/schemas/BackupSnapshot",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/v1/backups/create": {
        post: {
          summary: "Create backup snapshot",
          description:
            "Triggers a manual backup snapshot. The gateway exports a plaintext vbundle from the daemon, writes it locally, and encrypts + mirrors to offsite destinations.",
          operationId: "backupsCreate",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Backup snapshot created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["success", "local", "offsite", "duration_ms"],
                    properties: {
                      success: { type: "boolean" },
                      local: {
                        $ref: "#/components/schemas/BackupSnapshot",
                      },
                      offsite: {
                        type: "array",
                        items: { type: "object", additionalProperties: true },
                      },
                      duration_ms: { type: "number" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "403": { description: "Insufficient scope" },
            "409": {
              description: "A backup snapshot is already in progress",
            },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/{path}": {
        get: {
          summary: "Runtime proxy",
          description:
            "Reverse-proxies requests to the assistant runtime. Supports all HTTP methods.",
          operationId: "runtimeProxyGet",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Upstream path forwarded to the assistant runtime",
            },
          ],
          responses: {
            "200": {
              description: "Proxied response from the assistant runtime",
            },
            "401": {
              description: "Missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "404": {
              description: "Route not found on upstream runtime",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "500": {
              description:
                "Server misconfigured (proxy auth enabled without token)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Upstream connection failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "504": {
              description: "Upstream request timed out",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
        post: {
          summary: "Runtime proxy",
          description: "Reverse-proxies requests to the assistant runtime.",
          operationId: "runtimeProxyPost",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "path",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Upstream path forwarded to the assistant runtime",
            },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": {
              description: "Proxied response from the assistant runtime",
            },
            "401": {
              description: "Missing or invalid bearer token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Upstream connection failed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "504": {
              description: "Upstream request timed out",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        BackupSnapshot: {
          type: "object",
          required: ["path", "filename", "created_at", "size_bytes", "encrypted"],
          properties: {
            path: { type: "string" },
            filename: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            size_bytes: { type: "integer" },
            encrypted: { type: "boolean" },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["ok"] },
          },
        },
        ReadyResponse: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["ok"] },
          },
        },
        DrainingResponse: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["draining"] },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
          },
        },
        OkResponse: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
        OAuthAppSummary: {
          type: "object",
          required: [
            "id",
            "provider_key",
            "client_id",
            "created_at",
            "updated_at",
          ],
          properties: {
            id: { type: "string" },
            provider_key: { type: "string" },
            client_id: { type: "string" },
            created_at: { type: "integer" },
            updated_at: { type: "integer" },
          },
        },
        OAuthAppListResponse: {
          type: "object",
          required: ["apps"],
          properties: {
            apps: {
              type: "array",
              items: { $ref: "#/components/schemas/OAuthAppSummary" },
            },
          },
        },
        OAuthAppCreateRequest: {
          type: "object",
          required: ["provider_key", "client_id", "client_secret"],
          properties: {
            provider_key: { type: "string" },
            client_id: { type: "string" },
            client_secret: { type: "string" },
          },
        },
        OAuthAppCreateResponse: {
          type: "object",
          required: ["app"],
          properties: {
            app: { $ref: "#/components/schemas/OAuthAppSummary" },
          },
        },
        OAuthConnectionSummary: {
          type: "object",
          required: [
            "id",
            "provider_key",
            "account_info",
            "granted_scopes",
            "status",
            "has_refresh_token",
            "expires_at",
            "created_at",
            "updated_at",
          ],
          properties: {
            id: { type: "string" },
            provider_key: { type: "string" },
            account_info: { type: ["string", "null"] },
            granted_scopes: {
              type: "array",
              items: { type: "string" },
            },
            status: { type: "string" },
            has_refresh_token: { type: "boolean" },
            expires_at: { type: ["integer", "null"] },
            created_at: { type: "integer" },
            updated_at: { type: "integer" },
          },
        },
        OAuthConnectionListResponse: {
          type: "object",
          required: ["connections"],
          properties: {
            connections: {
              type: "array",
              items: { $ref: "#/components/schemas/OAuthConnectionSummary" },
            },
          },
        },
        OAuthConnectRequest: {
          type: "object",
          properties: {
            scopes: {
              type: "array",
              items: { type: "string" },
            },
            callback_transport: {
              type: "string",
              enum: ["loopback", "gateway"],
              description: "OAuth callback transport. Defaults to loopback.",
            },
          },
        },
        OAuthConnectDeferredResponse: {
          type: "object",
          required: ["auth_url", "state"],
          properties: {
            auth_url: { type: "string" },
            state: { type: "string" },
          },
        },
        OAuthConnectResponse: {
          oneOf: [
            { $ref: "#/components/schemas/OAuthConnectDeferredResponse" },
            { $ref: "#/components/schemas/OkResponse" },
          ],
        },
        TelegramOk: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
        TelegramUpdate: {
          type: "object",
          description: "Telegram Bot API Update object",
          properties: {
            update_id: { type: "integer" },
            message: { $ref: "#/components/schemas/TelegramMessage" },
            edited_message: {
              $ref: "#/components/schemas/TelegramMessage",
            },
          },
        },
        TelegramMessage: {
          type: "object",
          properties: {
            message_id: { type: "integer" },
            text: { type: "string" },
            caption: { type: "string" },
            chat: {
              type: "object",
              properties: {
                id: { type: "integer" },
                type: { type: "string" },
              },
            },
            from: {
              type: "object",
              properties: {
                id: { type: "integer" },
                is_bot: { type: "boolean" },
                username: { type: "string" },
                first_name: { type: "string" },
                last_name: { type: "string" },
                language_code: { type: "string" },
              },
            },
            photo: {
              type: "array",
              items: {
                $ref: "#/components/schemas/TelegramPhotoSize",
              },
            },
            document: { $ref: "#/components/schemas/TelegramDocument" },
          },
        },
        TelegramPhotoSize: {
          type: "object",
          properties: {
            file_id: { type: "string" },
            file_unique_id: { type: "string" },
            width: { type: "integer" },
            height: { type: "integer" },
            file_size: { type: "integer" },
          },
        },
        TelegramDocument: {
          type: "object",
          properties: {
            file_id: { type: "string" },
            file_unique_id: { type: "string" },
            file_name: { type: "string" },
            mime_type: { type: "string" },
            file_size: { type: "integer" },
          },
        },
        WhatsAppOk: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
        WhatsAppWebhookPayload: {
          type: "object",
          description: "WhatsApp Cloud API webhook notification payload",
          properties: {
            object: { type: "string", enum: ["whatsapp_business_account"] },
            entry: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  changes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        field: { type: "string" },
                        value: { type: "object", additionalProperties: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        PsResponse: {
          type: "object",
          required: ["processes"],
          properties: {
            processes: {
              type: "array",
              items: { $ref: "#/components/schemas/ProcessEntry" },
            },
          },
        },
        ProcessEntry: {
          type: "object",
          required: ["name", "status"],
          properties: {
            name: { type: "string" },
            status: {
              type: "string",
              enum: ["running", "not_running", "unreachable"],
            },
            info: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/components/schemas/ProcessEntry" },
            },
          },
        },
        IntegrationsStatusResponse: {
          type: "object",
          required: ["email"],
          description: "Current status of configured integrations.",
          properties: {
            email: {
              type: "object",
              required: ["address"],
              description: "Assistant email integration status.",
              properties: {
                address: {
                  type: ["string", "null"],
                  description:
                    "The assistant's email address, or null if not yet set up.",
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
        },
        TelegramWebhookSecret: {
          type: "apiKey",
          in: "header",
          name: "X-Telegram-Bot-Api-Secret-Token",
        },
        TwilioSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Twilio-Signature",
          description:
            "HMAC-SHA1 signature computed by Twilio over the request URL and form parameters.",
        },
        VellumSignature: {
          type: "apiKey",
          in: "header",
          name: "Vellum-Signature",
          description:
            "HMAC-SHA256 signature computed by the Vellum platform over the raw request body using the webhook secret. Format: sha256=<hex-digest>.",
        },
        WhatsAppHubSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Hub-Signature-256",
          description:
            "HMAC-SHA256 signature computed by Meta over the raw request body using the app secret.",
        },
      },
    },
  };
}
