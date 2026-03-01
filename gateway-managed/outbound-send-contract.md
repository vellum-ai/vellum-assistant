# Managed Gateway Outbound Send Contract

Endpoint: `POST /v1/internal/managed-gateway/outbound-send/`

Caller expectations:
- caller is an internal Vellum-managed gateway client only
- request body includes `route_id`, `assistant_id`, and `normalized_send`
- caller retries only on transport-level failures; 4xx responses are terminal

Authz boundary:
- requires managed gateway internal auth middleware (`bearer` or `mtls`)
- requires `messages:send` scope
- requires audience match to `MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE`

Response contract:
- `202`: accepted send envelope with `route_id`, `assistant_id`, `provider`, `route_type`, `identity_key`, and optional `delivery_id`
- `400`: error envelope (`validation_error`) for invalid payloads
- `401`: error envelope for internal auth failure
- `404`: pass-through error envelope (`managed_route_not_found`) from Django route ownership checks
