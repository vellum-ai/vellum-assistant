# Managed Twilio Voice Webhook Contract

Endpoint: `POST /webhooks/twilio/voice`

Caller expectations:
- caller is Twilio voice webhook delivery for managed shared identities
- request body is `application/x-www-form-urlencoded`
- payload includes `From`, `To`, `CallSid`, and `CallStatus`

Authz boundary:
- requires valid `X-Twilio-Signature`
- signature must verify against an active token in `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS`
- revoked or expired Twilio tokens are rejected

Response contract:
- `202`: accepted stub envelope for managed voice webhook path
- `400`: validation error envelope (`validation_error`) for malformed payloads
- `403`: auth failure envelope for missing/invalid signatures
- `405`: method-not-allowed envelope for non-POST methods
