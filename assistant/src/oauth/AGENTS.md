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

The `logoUrl` field in `seed-providers.ts` is the source of truth for a provider's logo. Most providers use a [Simple Icons](https://simpleicons.org) (CC0-licensed) CDN URL like `https://cdn.simpleicons.org/acme`. The web client resolves logos from this field (see `clients/web/src/components/integrations/integration-icon.tsx`) and falls back to an initials avatar.

For brands Simple Icons doesn't host (e.g. Salesforce, which Simple Icons removed for trademark reasons), use the `glincker/thesvg` source via jsDelivr — `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/<key>/default.svg`. The recognised `logoUrl` prefixes are enforced by `oauth-provider-seed-logos.test.ts`; if you need a third source, extend that allowlist.

### 5. Secret patterns (if applicable) — `../security/secret-patterns.ts`

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
