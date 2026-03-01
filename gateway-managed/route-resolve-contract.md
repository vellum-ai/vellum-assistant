# Managed Gateway Route Resolve Contract

Endpoint: `POST /v1/internal/managed-gateway/routes/resolve/`

Caller expectations:
- caller is an internal Vellum-managed gateway client only
- request body includes normalized routing keys: `provider`, `route_type`, `identity_key`
- caller retries only on transport-level failures; 4xx responses are terminal

Authz boundary:
- requires managed gateway internal auth middleware (`bearer` or `mtls`)
- requires `routes:resolve` scope
- requires audience match to `MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE`

Request normalization:
- `provider`: trim + lowercase
- `route_type`: trim + lowercase
- `identity_key`: trim + lowercase, strip `tel:` prefix, remove spaces

Response contract:
- `200`: pass-through route mapping payload from Django internal resolver
- `400`: error envelope (`validation_error`) for invalid payload
- `401`: error envelope for internal auth failure
- `404`: pass-through error envelope (`managed_route_not_found`) from Django
- `502`: error envelope for upstream transport or unexpected upstream status failures
