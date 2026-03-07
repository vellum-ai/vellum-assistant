import packageJson from "../package.json" with { type: "json" };

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
      "/v1/browser-relay/token": {
        get: {
          summary: "Browser relay bearer token",
          description:
            "Returns a short-lived JWT that the Chrome extension can use to authenticate its WebSocket connection to `/v1/browser-relay`. Only accessible from localhost (private network peers).",
          operationId: "getBrowserRelayToken",
          responses: {
            "200": {
              description: "Token minted successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: {
                        type: "string",
                        description:
                          "JWT bearer token for browser relay WebSocket authentication",
                      },
                    },
                    required: ["token"],
                  },
                },
              },
            },
            "403": {
              description:
                "Forbidden — only accessible from localhost / private network",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
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
      "/v1/home-base-ui": {
        get: {
          summary: "Home base UI",
          description:
            "Authenticated gateway endpoint that serves the home base dashboard UI from the assistant runtime.",
          operationId: "homeBaseUI",
          security: [{ BearerAuth: [] }],
          responses: {
            "200": {
              description: "Home base UI HTML returned",
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
      "/webhooks/twilio/voice": {
        post: {
          summary: "Twilio voice webhook",
          description:
            "Receives inbound Twilio voice webhooks, validates the X-Twilio-Signature, and forwards to the assistant runtime. Also available at /v1/calls/twilio/voice-webhook for backward compatibility.",
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
      "/webhooks/twilio/status": {
        post: {
          summary: "Twilio status webhook",
          description:
            "Receives Twilio call status callbacks, validates the X-Twilio-Signature, and forwards to the assistant runtime. Also available at /v1/calls/twilio/status for backward compatibility.",
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
      "/webhooks/twilio/connect-action": {
        post: {
          summary: "Twilio connect-action webhook",
          description:
            "Receives Twilio ConversationRelay connect-action callbacks, validates the X-Twilio-Signature, and forwards to the assistant runtime. Also available at /v1/calls/twilio/connect-action for backward compatibility.",
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
      "/deliver/whatsapp": {
        post: {
          summary: "WhatsApp delivery (internal)",
          description:
            "Internal endpoint called by the assistant runtime to deliver outbound WhatsApp messages. Not intended for external use.",
          operationId: "whatsappDeliver",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WhatsAppDeliverRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Message delivered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WhatsAppOk" },
                },
              },
            },
            "400": {
              description: "Invalid JSON or missing required fields",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized",
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
            "502": {
              description: "Failed to deliver via WhatsApp API",
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
      "/webhooks/twilio/relay": {
        get: {
          summary: "Twilio ConversationRelay WebSocket",
          description:
            "Accepts a WebSocket upgrade from Twilio ConversationRelay and bidirectionally proxies frames to the assistant runtime's /v1/calls/relay endpoint. Requires a callSessionId query parameter. Also available at /v1/calls/relay for backward compatibility.",
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
      "/pairing/register": {
        post: {
          summary: "Register pairing code",
          description:
            "Authenticated gateway endpoint that registers a new pairing code for device linking via the assistant runtime.",
          operationId: "pairingRegister",
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
            "200": { description: "Pairing code registered" },
            "400": { description: "Invalid request payload" },
            "401": {
              description: "Unauthorized — missing or invalid bearer token",
            },
            "502": { description: "Failed to reach assistant runtime" },
          },
        },
      },
      "/pairing/request": {
        post: {
          summary: "Request pairing",
          description:
            "Initiates a pairing request using a pairing code. Auth failures are tracked for rate limiting.",
          operationId: "pairingRequest",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          responses: {
            "200": { description: "Pairing request accepted" },
            "400": { description: "Invalid request payload" },
            "401": { description: "Unauthorized" },
            "403": { description: "Pairing code expired or invalid" },
            "502": { description: "Failed to reach assistant runtime" },
          },
        },
      },
      "/pairing/status": {
        get: {
          summary: "Check pairing status",
          description:
            "Checks the current status of a pairing request. Auth failures are tracked for rate limiting.",
          operationId: "pairingStatus",
          responses: {
            "200": { description: "Pairing status returned" },
            "401": { description: "Unauthorized" },
            "403": { description: "Pairing session not found" },
            "502": { description: "Failed to reach assistant runtime" },
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
              schema: { type: "string", enum: ["voice", "telegram"] },
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
      "/deliver/telegram": {
        post: {
          summary: "Telegram delivery (internal)",
          description:
            "Internal endpoint called by the assistant runtime to deliver outbound messages and attachments to a Telegram chat. Not intended for external use.",
          operationId: "telegramDeliver",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelegramDeliverRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Message delivered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/TelegramOk" },
                },
              },
            },
            "400": {
              description: "Invalid JSON or missing required fields",
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
            "502": {
              description: "Failed to deliver message via Telegram API",
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
      "/deliver/slack": {
        post: {
          summary: "Slack delivery (internal)",
          description:
            "Internal endpoint called by the assistant runtime to deliver outbound messages to a Slack channel via chat.postMessage. Not intended for external use.",
          operationId: "slackDeliver",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SlackDeliverRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Message delivered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SlackDeliverOk" },
                },
              },
            },
            "400": {
              description:
                "Invalid JSON, missing required fields, or unsupported attachments",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized",
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
            "502": {
              description: "Failed to deliver via Slack API",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "Slack integration not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/{path}": {
        get: {
          summary: "Runtime proxy",
          description:
            "Reverse-proxies requests to the assistant runtime when GATEWAY_RUNTIME_PROXY_ENABLED is true. Supports all HTTP methods. Returns 404 when the proxy is disabled.",
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
              description: "Runtime proxy not enabled",
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
          description:
            "Reverse-proxies requests to the assistant runtime when GATEWAY_RUNTIME_PROXY_ENABLED is true.",
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
        WhatsAppDeliverRequest: {
          type: "object",
          description:
            "Request to deliver a WhatsApp text message. Accepts either `to` or `chatId` (alias).",
          properties: {
            to: {
              type: "string",
              description: "Recipient WhatsApp phone number in E.164 format",
            },
            chatId: {
              type: "string",
              description:
                "Alias for `to` — used by runtime channel callback payloads",
            },
            text: {
              type: "string",
              description: "Text content to send",
              minLength: 1,
            },
            assistantId: {
              type: "string",
              description: "Optional assistant ID",
            },
            attachments: {
              type: "array",
              items: { type: "object" },
              description:
                "Attachments (not yet supported — a fallback text is sent instead)",
            },
          },
          allOf: [{ anyOf: [{ required: ["to"] }, { required: ["chatId"] }] }],
        },
        TelegramDeliverRequest: {
          type: "object",
          required: ["chatId"],
          description:
            "Request to deliver a message or chat action to a Telegram chat. At least one of `text`, `attachments`, or `chatAction` must be provided.",
          properties: {
            chatId: {
              type: "string",
              description: "Telegram chat ID to deliver the message to",
            },
            text: {
              type: "string",
              description: "Text content to send",
              minLength: 1,
            },
            assistantId: {
              type: "string",
              description:
                "Assistant ID (optional — attachments are downloaded via the assistant-less endpoint when omitted)",
            },
            chatAction: {
              type: "string",
              enum: ["typing"],
              description:
                "Optional Telegram chat action to emit (currently only `typing`)",
            },
            attachments: {
              type: "array",
              description:
                "Attachments to deliver (images sent via sendPhoto, others via sendDocument)",
              items: { $ref: "#/components/schemas/RuntimeAttachmentMeta" },
              minItems: 1,
            },
          },
          anyOf: [
            { required: ["text"] },
            { required: ["attachments"] },
            { required: ["chatAction"] },
          ],
        },
        RuntimeAttachmentMeta: {
          type: "object",
          required: ["id"],
          description:
            "Attachment metadata. Only `id` is required; missing fields are hydrated from the downloaded attachment data.",
          properties: {
            id: { type: "string" },
            filename: { type: "string" },
            mimeType: { type: "string" },
            sizeBytes: { type: "integer" },
            kind: { type: "string" },
          },
        },
        SlackDeliverRequest: {
          type: "object",
          description:
            "Request to deliver a message to a Slack channel. Accepts either `chatId` or `to` (alias) as the Slack channel ID.",
          properties: {
            chatId: {
              type: "string",
              description: "Slack channel ID to deliver the message to",
            },
            to: {
              type: "string",
              description:
                "Alias for `chatId` — used by runtime channel callback payloads",
            },
            text: {
              type: "string",
              description: "Text content to send",
              minLength: 1,
            },
            assistantId: {
              type: "string",
              description: "Optional assistant ID",
            },
          },
          allOf: [
            { anyOf: [{ required: ["chatId"] }, { required: ["to"] }] },
            { required: ["text"] },
          ],
        },
        SlackDeliverOk: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
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
