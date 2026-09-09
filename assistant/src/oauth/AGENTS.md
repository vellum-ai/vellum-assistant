# OAuth — Agent Instructions

## Adding a New First-Class Provider

When introducing a new built-in OAuth integration (one that appears in `seed-providers.ts`), touch each of the following areas. Items marked _(managed only)_ apply only when the provider supports platform-provided credentials.

### 1. Seed the provider — `seed-providers.ts`

Add an entry to `PROVIDER_SEED_DATA`. Required fields: `provider`, `authorizeUrl`, `tokenExchangeUrl`, `defaultScopes`, `displayLabel`, `description`, `dashboardUrl`, `clientIdPlaceholder`, `logoUrl`, and `injectionTemplates`. Optional: `availableScopes` — either a structured array of `{scope, description?}` objects or a URL string pointing to the provider's scope documentation. See existing entries for the full shape. The `provider` key must be snake_case and is used as the canonical identifier everywhere else.

If the provider will support managed mode, set `managedServiceConfigKey` to a slug matching the key you will add to `ServicesSchema` (e.g. `"acme-oauth"`).

### 2. _(managed only)_ Add a service schema — `../config/schemas/services.ts`

Create a schema and export its type:

```ts
export const AcmeOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type AcmeOAuthService = z.infer<typeof AcmeOAuthServiceSchema>;
```

Then add the key to `ServicesSchema`:

```ts
"acme-oauth": AcmeOAuthServiceSchema.default(AcmeOAuthServiceSchema.parse({})),
```

The key here **must** match the `managedServiceConfigKey` in `seed-providers.ts`. The cross-repo invariant test in `__tests__/seed-providers-managed.test.ts` will fail if they drift.

### 3. _(managed only)_ Enable by default during onboarding

Managed-sign-in users should get the integration pre-enabled by setting `services.acme-oauth.mode` to `"managed"` in the client's onboarding config defaults.

### 4. Set the logo URL — `seed-providers.ts`

The `logoUrl` field in `seed-providers.ts` is the source of truth for a provider's logo. Most providers use a [Simple Icons](https://simpleicons.org) (CC0-licensed) CDN URL like `https://cdn.simpleicons.org/acme`.

**Verify the URL actually resolves before you commit it.** `oauth-provider-seed-logos.test.ts` only checks the prefix, so a slug that Simple Icons has never hosted (or has since dropped) passes CI and then renders as an initials avatar in the client. Simple Icons removes brands on trademark request: Salesforce is gone, every Microsoft product went in v13, and Slack is currently absent pending permission from the trademark owner. For those, use the `glincker/thesvg` source via jsDelivr: `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/<key>/default.svg`. The recognised `logoUrl` prefixes are enforced by `oauth-provider-seed-logos.test.ts`; if you need a third source, extend that allowlist.

`logoUrl` is a fallback, not the last word. The web client prefers a logo bundled in `clients/web/public/images/integrations/` when one exists for the provider key, uses `logoUrl` when it doesn't, and only then falls back to an initials avatar (see `BUNDLED_LOGO_URLS` in `clients/web/src/components/integrations/integration-icon.tsx`). Bundling an asset for a new first-class provider is optional but preferred: it survives a CDN removal, works offline, and keeps the integrations list from telling a third party which providers a user is looking at.

### 5. Secret patterns (if applicable) — `packages/service-contracts/src/secret-detection.ts`

If the provider issues API keys with a recognizable prefix (e.g. `acme_sk_`), add a `PREFIX_PATTERNS` entry. OAuth-only services with opaque access tokens do not need one. See `../security/AGENTS.md` for details.

### 6. Feature-flag gating (optional) — `seed-providers.ts`

Set `featureFlag: "acme-oauth"` in the seed entry and register the flag in `meta/feature-flags/feature-flag-registry.json` to hide the provider until the flag is enabled. Omit `featureFlag` to make the provider visible immediately.

### What you do NOT need to change

The following are wired automatically once `PROVIDER_SEED_DATA` has an entry:

- **Connection resolver** (`connection-resolver.ts`) — routes managed vs. BYO based on config.
- **CLI commands** (`../cli/commands/oauth/`) — `providers list`, `providers get`, `connect`, `disconnect`, etc.
- **Runtime API** (`../runtime/routes/oauth-providers.ts`) — `GET /v1/oauth/providers` and related endpoints.
- **Gateway proxy** (`gateway/src/http/routes/oauth-providers-proxy.ts`) — forwards to the runtime.
- **OAuth store** (`oauth-store.ts`) — seeding uses upsert; schema already supports arbitrary providers.
- **Provider serialization** (`provider-serializer.ts`) — generic over all providers.
- **Passthrough proxy** (`../runtime/routes/oauth-proxy-routes.ts`): resolves any seeded or registered provider, so a new provider needs no proxy-specific work beyond a `baseUrl`. That field is optional for a provider generally, but a BYO provider without one fails resolution, so every proxied request returns 424 until it is set.

## Passthrough Proxy for Third-Party CLIs

A stock third-party CLI reaches a provider's API through the daemon without ever seeing the provider credential. It points its API base at the proxy and sends a short-lived grant as its bearer token; the proxy strips that grant, substitutes the resolved connection's credential, and forwards the request.

### Route

`oauth/proxy/:provider/:path*` (`../runtime/routes/oauth-proxy-routes.ts`), registered once per forwarded method (GET, POST, PUT, PATCH, DELETE, HEAD) under operation IDs `oauth_proxy_get`, `oauth_proxy_post`, and so on. Those ids are what IPC dispatch uses; `openapi.yaml` derives its own from the path, so the same routes read there as `oauth_proxy_by_provider_by_path_get` and the mint as `oauth_proxygrant_post`. OPTIONS is absent: a CORS preflight has no meaning for a CLI calling a loopback daemon. Every registration requires the `oauth.proxy` scope and a local principal.

Only the HTTP adapter supplies the wire-exact URL the route forwards, so an IPC dispatch throws `HttpTransportRequiredError` (421, `BINARY_UNSUPPORTED_OVER_IPC`). That is the gateway's existing retry signal: its IPC proxy falls through to the HTTP proxy, so the caller is served rather than failed. The refusal precedes the provider lookup and the resolution, so upstream still runs exactly once.

Wire semantics live in `../runtime/routes/oauth-proxy-passthrough.ts`. The remainder path reaches the provider as the caller wrote it: `.` and `..` collapse, an absolute URL, `//host`, or an empty segment is a 400, and no segment is decoded or re-encoded, so a `%2F` survives. No `baseUrl` is passed to the connection, so its own API base is the only host ever targeted.

### Provider segment

The first segment is `provider` or `provider@account`, the account pinning one connection when a provider has several. Proxy provider keys contain only ASCII letters, digits, `.`, `_`, `~`, and `-`, and cannot be `.` or `..`. Encoding and parsing share this validation so URL delimiters, percent escapes, and normalization cannot change the provider or grant subject. Accounts are percent-encoded for the same reason. When several accounts are connected and none is pinned, both answer 409, but they say different things. The mint names the accounts, because the caller is the local operator choosing one. Unlabeled BYO connections can be selected with their exact connection ID; account-label matches take precedence, and provider, client, and active-status filters apply to either selector. The proxy names none, because its caller is the third-party binary holding the grant; it says to mint a grant pinned with `--account`, which is the only thing that resolves it. Rewriting the segment would not, since the subject check runs before resolution.

### Grant

`oauth/proxy-grant` (`oauth_proxy_grant`, `../runtime/routes/oauth-proxy-grant-routes.ts`) requires `settings.write` and a local principal. It resolves the connection first, then mints a token with the subject `local:self:oauth-proxy.<segment>` and the `oauth_proxy_v1` profile, whose only scope is `oauth.proxy`. TTL is 60 to 3600 seconds, 900 by default.

The proxy re-derives that subject from the segment on the request and compares it against the verified `x-vellum-subject` before anything else runs:

- Unpinned grant, bare provider segment: allowed.
- Grant pinned to an account, that account's segment: allowed.
- Pinned grant, a different account or the bare segment: 403.
- Unpinned grant, any account segment: 403.

A grant is pinned when the caller passed `--account` or the resolved connection carries an `accountInfo`. An unpinned grant is therefore bound to the provider, not to the connection row it was minted against: revoke that connection and replace it inside the grant's lifetime and the grant reaches the replacement. That is accepted, given the TTL.

### Containment

The grant carries one scope for one route, and four checks hold it there:

- **Gateway edge auth** (`gateway/src/http/middleware/auth.ts`) refuses it on every gateway-native route, with no loopback fallback. `isSingleRouteGrant` calls `isNarrowScopeProfile` from `gateway/src/auth/scopes.ts`, and also catches a proxy subject carrying some other profile. The passthrough itself never passes through edge auth: it falls to the runtime-proxy catch-all, which re-mints the grant's own subject and profile for the daemon. That holds whether or not the gateway requires client-facing auth (`gateway.runtimeProxyRequireAuth`, off under `dev:proxy`): a presented grant is validated the same way in both modes and only a caller presenting no valid grant is answered with the gateway's own service token, so the minted URL works in either and neither mode hands the grant more than `oauth.proxy`.
- **The gateway's IPC fast path** (`gateway/src/http/routes/ipc-runtime-proxy.ts`) refuses it against any daemon route naming no scope. The daemon's IPC server runs no policy check of its own, so this is the only enforcement an IPC-served request gets.
- **`enforcePolicy`** (`../runtime/auth/route-policy.ts`) refuses the same on the HTTP path, then applies the route's own scopes. `oauth.proxy` reaches the passthrough and nothing else. It runs wherever `routeRequest` dispatches through the router, which is every `/v1` route and the shareable-pages path bar three groups that earlier branches answer first, each carrying a gate of its own: `GET /v1/audio/:audioId`, deliberately public and served before `authenticateRequest` runs at all because Twilio fetches it directly; the Twilio webhook paths (`TWILIO_WEBHOOK_RE`), also pre-auth and gated on Twilio's request signature; and the WebSocket upgrades in the next bullet, which never reach the route table. A route added anywhere else is covered.
- **WebSocket upgrades** (`/v1/calls/media-stream`, `/v1/stt/stream`, `/v1/live-voice`, `/v1/watch/stream`) are handled before the route table on both hops, so neither edge auth nor `enforcePolicy` sees them, and each carries its own identity gate. The daemon admits only a private-network peer presenting a gateway service token; at the edge it is an actor principal on `runtime-audio-stream` and `live-voice`, the `speech.relay` scope on the relay, and the relay-token identity on `twilio-media-websocket`.

The gateway classifies profiles once, in `isNarrowScopeProfile`. The daemon keeps its own copy, because the cross-package import boundary forbids sharing a module, so widening one means editing both. Each is backed by a `Record<ScopeProfile, boolean>`, so a new profile fails to compile until it is classified rather than silently landing outside and failing closed.

### CLI

`assistant oauth proxy-url <provider>` mints a grant and prints it as JSON, or with `--export` as `export` lines for `eval`: `VELLUM_OAUTH_PROXY_BASE_URL`, `VELLUM_OAUTH_PROXY_TOKEN`, `VELLUM_OAUTH_PROXY_EXPIRES_AT`, and `VELLUM_OAUTH_PROXY_ACCOUNT` when the grant pinned one. The names are provider-neutral by design; the calling skill or wrapper maps them onto whatever its CLI reads (the command's help shows the Link example). The command is `medium` risk in the gateway's bash command registry (`gateway/src/risk/command-registry/commands/assistant.ts`).

### Byte fidelity and managed-mode limits

The route asks each connection for `rawResponseBody: true`, `manualRedirect: true`, the wire-exact `rawQuery`, and `singleAttempt` on every non-idempotent method.

A BYO connection honors the first three: the provider's bytes come back untouched, the query reaches the provider as the caller wrote it, and a 3xx is surfaced rather than followed, since following it would replay a POST upstream as a GET the caller never asked for and hide the 3xx from the client whose job it is to handle it. It needs no `singleAttempt`, having made its one attempt already; its only retry follows a provider 401, which rejected the request before it took effect.

The 3xx status survives; its target does not stay in `location`. `materializeProxyResponse` moves it onto `x-vellum-proxy-location` and drops `location`, so nothing auto-follows the redirect back to the provider carrying the grant as its bearer token. A client that keeps `Authorization` across hosts (`curl --location-trusted`, a hand-rolled redirect loop) would otherwise hand a live daemon credential to the third party on the first hop. The target stays readable under a name nothing follows. Non-redirect responses, including `201 Created`, retain `location`.

A managed connection is proxied by the platform, which parses the response and rebuilds the request server-side, so most of that does not survive:

- **Response bytes.** `rawResponseBody` cannot be honored. A managed JSON response is parsed and re-serialized, which drops duplicate keys and rounds integers past `Number.MAX_SAFE_INTEGER`.
- **Query fidelity.** `rawQuery` cannot be honored either; the parsed `query` record travels instead and the platform rebuilds the string. Interleaved repeated keys are regrouped, `%20` becomes `+`, and a valueless `?flag` becomes `flag=`. A provider that signs its own query string therefore works over BYO and cannot work over managed.
- **Redirects.** The platform follows a 3xx itself, so the caller gets the destination's response and never the 3xx. `manualRedirect` does not apply.
- **HEAD.** Not forwarded; the route answers 405 before calling a managed connection.

`singleAttempt` is the one that does apply, which is why the route sets it: the platform retries a 502 it returns only after already calling the provider, so a proxied write the caller cannot repeat would otherwise be replayed.

Managed mode inherits the platform proxy's narrowing too:

- Request headers are limited to `content-type`, `accept`, `user-agent`, and `x-request-id`, plus the provider's configured defaults. The passthrough route rejects unsupported headers with 400 before sending the provider request, including conditional, idempotency, and provider-version headers. Node fetch defaults `accept-language: *` and `sec-fetch-mode: cors` are discarded. This check applies only to passthrough requests; other managed connection callers keep their existing behavior.
- Response headers are narrowed to `Content-Type`, `X-Rate-Limit-Remaining`, and `X-Rate-Limit-Reset`.
- Request and response bodies are size-capped platform-side.

The proxy is byte-exact on BYO connections only, and `stripe_link`, the connection it was built for, is managed-only, so these limits are live rather than theoretical.

### Security invariants

- The caller's `authorization` never reaches the provider. `sanitizeInboundHeaders` also drops proxy-auth, hop-by-hop framing, `host`, `cookie`, `accept-encoding`, forwarding hints, every `x-forwarded-*`, and every `x-vellum-*`, so an inbound header cannot forge a gateway signal. Content type, accept, user agent, and other custom `x-*` headers pass through on BYO connections; managed passthrough requests also face the header check above.
- The response is stripped in the same spirit. `set-cookie` and `set-cookie2` go, so a provider cannot plant state on the daemon's own origin; the request side already drops an inbound `cookie`, so one could never round-trip anyway. Every provider-supplied `x-vellum-*` goes, since that namespace is this daemon's on both sides of the hop. `location` is relocated to `x-vellum-proxy-location` only for 3xx responses. Framing headers go because the response is re-framed on the way out.
- Nothing logs the grant or the credential. The proxy logs provider, method, path, and status; the mint logs provider, account, and TTL.
- The route calls `connection.request()` only, so the raw token stays inside the connection.

### Error mapping

`ERROR_RESPONSES` in `../runtime/routes/oauth-proxy-routes.ts` is the list, and it generates the `openapi.yaml` entries; do not copy it here. Two mappings are worth knowing without opening it: 421 means the request was dispatched over IPC and the gateway retries it over HTTP on the caller's behalf, and 424 carries `assistant oauth connect <provider>` in its details.
