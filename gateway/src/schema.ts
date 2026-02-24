import packageJson from "../package.json" with { type: "json" };

export function buildSchema(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Vellum Gateway",
      version: packageJson.version,
      description:
        "HTTP gateway that bridges external channels (Telegram, SMS, etc.) to the Vellum assistant runtime and provides an authenticated reverse proxy.",
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
                schema: { type: "object", additionalProperties: { type: "string" } },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook processed, runtime response forwarded",
            },
            "403": {
              description: "Twilio signature validation failed or auth token not configured",
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
                schema: { type: "object", additionalProperties: { type: "string" } },
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
                schema: { type: "object", additionalProperties: { type: "string" } },
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
      "/webhooks/twilio/sms": {
        post: {
          summary: "Twilio SMS webhook",
          description:
            "Receives inbound Twilio SMS webhooks, validates the X-Twilio-Signature, normalizes the payload into a gateway inbound event with sourceChannel 'sms', and forwards to the assistant runtime.",
          operationId: "twilioSmsWebhook",
          security: [{ TwilioSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: { type: "object", additionalProperties: { type: "string" } },
              },
            },
          },
          responses: {
            "200": {
              description: "SMS accepted",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SmsOk" },
                },
              },
            },
            "400": {
              description: "Missing MessageSid or invalid body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "403": {
              description: "Twilio signature validation failed or auth token not configured",
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
              description: "Internal error processing inbound SMS",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/deliver/sms": {
        post: {
          summary: "SMS delivery (internal)",
          description:
            "Internal endpoint called by the assistant runtime to deliver outbound SMS messages via Twilio. Not intended for external use.",
          operationId: "smsDeliver",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SmsDeliverRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "SMS delivered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SmsOk" },
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
              description: "Method not allowed (only POST accepted)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "502": {
              description: "Failed to deliver message via Twilio Messages API",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            "503": {
              description: "SMS integration not configured",
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
              description: "Verification successful — challenge echoed as plain text",
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
              description: "Call session identifier used to correlate the WebSocket connection with the runtime relay session.",
            },
          ],
          responses: {
            "101": {
              description: "WebSocket upgrade successful — bidirectional frame proxying begins.",
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
              description: "Opaque state parameter used to correlate the callback with the original OAuth flow.",
            },
            {
              name: "code",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Authorization code returned by the OAuth provider on success.",
            },
            {
              name: "error",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Error code returned by the OAuth provider on failure.",
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
              description: "Missing state parameter or authorization failed — HTML error page rendered",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            "502": {
              description: "Failed to forward callback to assistant runtime — HTML error page rendered",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/integrations/status": {
        get: {
          summary: "Integration status",
          description:
            "Returns the current status of configured integrations, including the assistant's email address. The desktop app uses this endpoint to display integration info in its settings UI.",
          operationId: "integrationsStatus",
          responses: {
            "200": {
              description: "Integration status",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/IntegrationsStatusResponse" },
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
              description:
                "Upstream path forwarded to the assistant runtime",
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
              description:
                "Upstream path forwarded to the assistant runtime",
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
        SmsOk: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
          },
        },
        SmsDeliverRequest: {
          type: "object",
          description: "Request to deliver an SMS message via Twilio. Provide either `to` or `chatId` (alias) as the recipient phone number. `text` is optional when `attachments` are present — a fallback text message is sent instead.",
          properties: {
            to: { type: "string", description: "Recipient phone number in E.164 format" },
            chatId: { type: "string", description: "Alias for `to` — recipient phone number in E.164 format. Used by the runtime channel callback payload." },
            text: { type: "string", description: "Text content to send", minLength: 1 },
            assistantId: { type: "string", description: "Optional assistant ID for per-assistant phone number resolution in multi-assistant setups" },
            attachments: { type: "array", items: { type: "object" }, minItems: 1, description: "Media attachments. When text is empty but attachments are present, a fallback text message is sent instead." },
          },
          allOf: [
            { anyOf: [{ required: ["to"] }, { required: ["chatId"] }] },
            { anyOf: [{ required: ["text"] }, { required: ["attachments"] }] },
          ],
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
          description: "Request to deliver a WhatsApp text message. Accepts either `to` or `chatId` (alias).",
          properties: {
            to: { type: "string", description: "Recipient WhatsApp phone number in E.164 format" },
            chatId: { type: "string", description: "Alias for `to` — used by runtime channel callback payloads" },
            text: { type: "string", description: "Text content to send", minLength: 1 },
            assistantId: { type: "string", description: "Optional assistant ID" },
            attachments: { type: "array", items: { type: "object" }, description: "Attachments (not yet supported — a fallback text is sent instead)" },
          },
          allOf: [
            { anyOf: [{ required: ["to"] }, { required: ["chatId"] }] },
          ],
        },
        TelegramDeliverRequest: {
          type: "object",
          required: ["chatId"],
          description:
            "Request to deliver a message to a Telegram chat. At least one of `text` or `attachments` must be provided.",
          properties: {
            chatId: { type: "string", description: "Telegram chat ID to deliver the message to" },
            text: { type: "string", description: "Text content to send", minLength: 1 },
            assistantId: { type: "string", description: "Assistant ID (optional — attachments are downloaded via the assistant-less endpoint when omitted)" },
            attachments: {
              type: "array",
              description: "Attachments to deliver (images sent via sendPhoto, others via sendDocument)",
              items: { $ref: "#/components/schemas/RuntimeAttachmentMeta" },
              minItems: 1,
            },
          },
          anyOf: [
            { required: ["text"] },
            { required: ["attachments"] },
          ],
        },
        RuntimeAttachmentMeta: {
          type: "object",
          required: ["id"],
          description: "Attachment metadata. Only `id` is required; missing fields are hydrated from the downloaded attachment data.",
          properties: {
            id: { type: "string" },
            filename: { type: "string" },
            mimeType: { type: "string" },
            sizeBytes: { type: "integer" },
            kind: { type: "string" },
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
                  description: "The assistant's email address, or null if not yet set up.",
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
          description: "HMAC-SHA1 signature computed by Twilio over the request URL and form parameters.",
        },
        WhatsAppHubSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Hub-Signature-256",
          description: "HMAC-SHA256 signature computed by Meta over the raw request body using the app secret.",
        },
      },
    },
  };
}
