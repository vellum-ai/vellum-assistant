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

`oauth/proxy/:provider/:path*` (`../runtime/routes/oauth-proxy-routes.ts`), registered once per forwarded method (GET, POST, PUT, PATCH, DELETE, HEAD) under operation IDs `oauth_proxy_get`, `oauth_proxy_post`, and so on. OPTIONS is absent: a CORS preflight has no meaning for a CLI calling a loopback daemon. Every registration requires the `oauth.proxy` scope and a local principal.

Only the HTTP adapter supplies the wire-exact URL the route forwards, so an IPC dispatch throws `HttpTransportRequiredError` (421, `BINARY_UNSUPPORTED_OVER_IPC`). That is the gateway's existing retry signal: its IPC proxy falls through to the HTTP proxy, so the caller is served rather than failed. The refusal precedes the provider lookup and the resolution, so upstream still runs exactly once.

Wire semantics live in `../runtime/routes/oauth-proxy-passthrough.ts`. The remainder path reaches the provider as the caller wrote it: `.` and `..` collapse, an absolute URL, `//host`, or an empty segment is a 400, and no segment is decoded or re-encoded, so a `%2F` survives. No `baseUrl` is passed to the connection, so its own API base is the only host ever targeted.

### Provider segment

The first segment is `provider` or `provider@account`, the account pinning one connection when a provider has several. `encodeProxyProviderSegment` refuses a provider key that is empty or holds `@`, `/`, or `:`: the first two would parse back as a different provider, and a `:` would split the grant subject into a fourth component that no subject parser accepts, yielding a grant that could never verify. Accounts are percent-encoded for the same reason. When several accounts are connected and none is pinned, both the mint and the proxy answer 409 naming the accounts and an example segment.

### Grant

`oauth/proxy-grant` (`oauth_proxy_grant`, `../runtime/routes/oauth-proxy-grant-routes.ts`) requires `settings.write` and a local principal. It resolves the connection first, then mints a token with the subject `local:self:oauth-proxy.<segment>` and the `oauth_proxy_v1` profile, whose only scope is `oauth.proxy`. TTL is 60 to 3600 seconds, 900 by default.

The proxy re-derives that subject from the segment on the request and compares it against the verified `x-vellum-subject` before anything else runs:

- Unpinned grant, bare provider segment: allowed.
- Grant pinned to an account, that account's segment: allowed.
- Pinned grant, a different account or the bare segment: 403.
- Unpinned grant, any account segment: 403.

A grant is pinned when the caller passed `--account` or the resolved connection carries an `accountInfo`. An unpinned grant is therefore bound to the provider, not to the connection row it was minted against: revoke that connection and replace it inside the grant's lifetime and the grant reaches the replacement. That is accepted, given the TTL.

### CLI

`assistant oauth proxy-url <provider>` mints a grant and prints it as JSON, or with `--export` as `export` lines for `eval`: `VELLUM_OAUTH_PROXY_BASE_URL`, `VELLUM_OAUTH_PROXY_TOKEN`, `VELLUM_OAUTH_PROXY_EXPIRES_AT`, and `VELLUM_OAUTH_PROXY_ACCOUNT` when the grant pinned one. The names are provider-neutral by design; the calling skill or wrapper maps them onto whatever its CLI reads (the command's help shows the Link example). The command is `medium` risk in the gateway's bash command registry (`gateway/src/risk/command-registry/commands/assistant.ts`).

### Byte fidelity and managed-mode limits

The route asks each connection for `rawResponseBody: true` and `manualRedirect: true`.

A BYO connection honors both. The provider's bytes come back untouched, and a 3xx is returned verbatim with its `Location` intact instead of being followed: following it would replay a POST upstream as a GET the caller never asked for and hide the 3xx from the client whose job it is to handle it.

A managed connection cannot honor `rawResponseBody`, because the platform proxy parses the response server-side. A managed JSON response is therefore parsed and re-serialized, which drops duplicate keys and rounds integers past `Number.MAX_SAFE_INTEGER`. Managed mode inherits the platform proxy's other limits too:

- Request headers are narrowed to `content-type`, `accept`, `user-agent`, and `x-request-id`, plus the provider's configured defaults.
- HEAD is not forwarded; the route answers 405 before calling a managed connection.
- Response headers are narrowed to `Content-Type`, `X-Rate-Limit-Remaining`, and `X-Rate-Limit-Reset`.
- Request and response bodies are size-capped platform-side.

These are known limits: the proxy is byte-exact on BYO connections only. `stripe_link`, the connection it was built for, is managed.

### Security invariants

- The caller's `authorization` never reaches the provider. `sanitizeInboundHeaders` also drops proxy-auth, hop-by-hop framing, `host`, `cookie`, `accept-encoding`, forwarding hints, every `x-forwarded-*`, and every `x-vellum-*`, so an inbound header cannot forge a gateway signal. Content type, accept, user agent, and other custom `x-*` headers pass through.
- Nothing logs the grant or the credential. The proxy logs provider, method, path, and status; the mint logs provider, account, and TTL.
- The route calls `connection.request()` only, so the raw token stays inside the connection.

### Error mapping

- 400: malformed provider segment or proxied path.
- 402: the managed account is out of balance.
- 403: the grant names another provider or account.
- 404: unknown provider.
- 405: HEAD against a managed connection.
- 409: several accounts connected, none pinned.
- 421: dispatched over IPC; retry over HTTP.
- 424: no usable connection. The details carry `assistant oauth connect <provider>`.
- 502: the provider API could not be reached.
