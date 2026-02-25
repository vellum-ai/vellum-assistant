# SMS/Twilio Parity Verification Checklist

Moved from the root architecture document to keep implementation-level verification close to gateway ownership.

## SMS/Twilio Parity Verification Checklist

This section tracks the SMS channel's feature parity with the Telegram channel and verifies that all SMS/Twilio behaviors match their documented contracts. Each item maps to a specific behavior shipped across the SMS/Twilio Faithfulness Remediation milestones (M1-M5).

### Test Matrix

| Area | Behavior | Verified By | Source Files |
|------|----------|-------------|--------------|
| **SMS Reply Delivery** | `/deliver/sms` accepts `{ to, text }` for outbound SMS | `gateway/src/http/routes/sms-deliver.test.ts` | `gateway/src/http/routes/sms-deliver.ts` |
| **SMS Reply Delivery** | `/deliver/sms` accepts `{ chatId, text }` as alias for `to` (runtime channel callback compatibility) | `gateway/src/http/routes/sms-deliver.test.ts` | `gateway/src/http/routes/sms-deliver.ts` |
| **SMS Reply Delivery** | When both `to` and `chatId` are provided, `to` takes precedence | `gateway/src/http/routes/sms-deliver.test.ts` | `gateway/src/http/routes/sms-deliver.ts` |
| **SMS Reply Delivery** | Fail-closed auth: 503 when no bearer token configured and bypass not set | `gateway/src/http/routes/sms-deliver.test.ts` | `gateway/src/http/routes/sms-deliver.ts` |
| **SMS `/new` Reset** | `/new` command (case-insensitive, trimmed) resets conversation via runtime API | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **SMS `/new` Reset** | Confirmation SMS sent after successful reset | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **SMS `/new` Reset** | `/new` message is not forwarded to runtime (intercepted at gateway) | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **SMS `/new` Rejection** | `/new` with routing rejection sends rejection notice SMS to sender (matching Telegram UX) | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **MMS Unsupported** | `NumMedia > 0` triggers explicit unsupported notice to sender | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **MMS Unsupported** | `MediaUrl<N>` with non-empty value triggers MMS detection even when `NumMedia` is absent | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **MMS Unsupported** | `MediaContentType<N>` with non-empty value triggers MMS detection even when `NumMedia` is absent | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **MMS Unsupported** | MMS payloads are not forwarded to the runtime | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **Twilio Setup** | `provision_number` auto-assigns number to config and secure storage | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Twilio Setup** | `provision_number` auto-configures webhooks (voice, status, SMS) when ingress URL is available | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Twilio Setup** | `assign_number` auto-assigns and auto-configures webhooks consistently with `provision_number` | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Twilio Setup** | Webhook configuration is best-effort (non-fatal when ingress not yet configured) | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Twilio Setup** | SMS webhook URL (`/webhooks/twilio/sms`) included in auto-configured webhooks | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/inbound/public-ingress-urls.ts` |
| **Ingress Boundary** | Direct POST to `/webhooks/twilio/sms` on runtime returns `410 GATEWAY_ONLY` | `assistant/src/__tests__/gateway-only-enforcement.test.ts` | `assistant/src/runtime/http-server.ts` |
| **Ingress Boundary** | Direct POST to legacy `/v1/calls/twilio/sms` on runtime returns `410 GATEWAY_ONLY` | `assistant/src/__tests__/gateway-only-enforcement.test.ts` | `assistant/src/runtime/http-server.ts` |
| **Ingress Boundary** | SMS webhook at gateway validates `X-Twilio-Signature` (HMAC-SHA1) | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/twilio/validate-webhook.ts` |
| **Ingress Boundary** | `MessageSid` deduplication prevents reprocessing retried webhooks | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **Settings UI** | `list_numbers` IPC action lists all incoming phone numbers with capabilities | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Settings UI** | `set_credentials` validates and stores Account SID and Auth Token in secure storage | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Settings UI** | `clear_credentials` removes auth credentials but preserves phone number in config and secure key | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Settings UI** | `getTwilioConfig()` resolves phone number with priority: env var > config > secure key | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/calls/twilio-config.ts` |
| **Settings UI** | Single-number-per-assistant model: number stored at `sms.phoneNumber` in config | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `get` with `assistantId` returns per-assistant phone number from `sms.assistantPhoneNumbers` mapping | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `get` with `assistantId` falls back to legacy `sms.phoneNumber` when no mapping exists | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `assign_number` with `assistantId` persists into `sms.assistantPhoneNumbers`; only sets legacy `sms.phoneNumber` if empty | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `assign_number` with `assistantId` sets legacy `phoneNumber` as fallback when empty | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `assign_number` with `assistantId` does not clobber existing global `phoneNumber` | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Assistant-Scoped Numbers** | `assign_number` without `assistantId` does not create `assistantPhoneNumbers` mapping | `assistant/src/__tests__/handlers-twilio-config.test.ts` | `assistant/src/daemon/handlers/config.ts` |
| **Phone Number Routing** | SMS webhook routes by inbound `To` number via `assistantPhoneNumbers` reverse lookup | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **Phone Number Routing** | Phone number routing takes priority over standard routing chain | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **Phone Number Routing** | Falls through to standard routing when `To` number is not in `assistantPhoneNumbers` | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts` |
| **Phone Number Routing** | Routing override is passed through to `handleInbound()` for phone-number routes | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts`, `gateway/src/handlers/handle-inbound.ts` |
| **Phone Number Routing** | Default routing is also passed as routing override to `handleInbound()` | `gateway/src/http/routes/twilio-sms-webhook.test.ts` | `gateway/src/http/routes/twilio-sms-webhook.ts`, `gateway/src/handlers/handle-inbound.ts` |
