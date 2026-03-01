# Managed Twilio SMS Webhook Contract

Endpoint: `POST /webhooks/twilio/sms`

Caller expectations:
- caller is Twilio webhook delivery for managed shared identities
- request body is `application/x-www-form-urlencoded`
- payload includes `From`, `To`, and `MessageSid`

Authz boundary:
- requires valid `X-Twilio-Signature`
- signature must verify against an active token in `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS`
- revoked or expired Twilio tokens are rejected

Response contract:
- `202`: accepted dispatch envelope for managed SMS webhook path, including resolved route metadata and dispatch receipt
- `400`: validation error envelope (`validation_error`) for malformed payloads
- `403`: auth failure envelope for missing/invalid signatures
- `404`: route resolution error envelope when managed route mapping is missing
- `502`: dispatch upstream error envelope when Django/vembda/runtime forwarding fails
- `405`: method-not-allowed envelope for non-POST methods
