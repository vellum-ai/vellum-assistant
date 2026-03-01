# Managed Gateway Inbound Dispatch Contract

Endpoint: `POST /v1/internal/managed-gateway/inbound/dispatch/`

Caller expectations:
- caller is an internal Vellum-managed gateway client only
- request body includes `route_id`, `assistant_id`, and `normalized_event`
- caller retries only on transport-level failures; 4xx responses are terminal

Authz boundary:
- requires managed gateway internal auth middleware (`bearer` or `mtls`)
- requires `events:dispatch` scope
- requires audience match to `MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE`

Response contract:
- `202`: accepted dispatch envelope with `route_id`, `assistant_id`, optional `event_id`, and optional `duplicate`
- `400`: error envelope (`validation_error`) for invalid payloads
- `401`: error envelope for internal auth failure
- `404`: pass-through error envelope (`managed_route_not_found`) from Django route ownership checks
- `502`: error envelope for upstream transport or unexpected upstream status failures
