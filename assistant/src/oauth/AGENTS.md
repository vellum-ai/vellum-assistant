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

### 3. _(managed only)_ Enable by default during onboarding — `clients/macos/.../HatchingStepView.swift`

In `buildOnboardingConfigValues()`, add a line so managed-sign-in users get the integration pre-enabled:

```swift
configValues["services.acme-oauth.mode"] = "managed"
```

### 4. Add a cached logo — `clients/shared/Resources/IntegrationLogos/`

Drop a **vector PDF** named `{provider_key}.pdf` (e.g. `acme.pdf`) into the `IntegrationLogos/` directory. The file is automatically bundled via `.copy()` in `clients/Package.swift` and looked up at runtime by `IntegrationLogoBundle` using the provider key — no code changes needed.

Most existing logos come from [Simple Icons](https://simpleicons.org) (CC0-licensed). To get a PDF from Simple Icons:

1. Find the icon slug on https://simpleicons.org (e.g. `slack`, `linear`).
2. Download the SVG: `curl -o acme.svg https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/acme.svg`
3. Convert to PDF using `rsvg-convert` (same tool used by `clients/scripts/sync-lucide-icons.sh`):
   ```bash
   # Install if needed: brew install librsvg
   rsvg-convert -f pdf -o clients/shared/Resources/IntegrationLogos/acme.pdf acme.svg
   ```
4. Add the provider key to `clients/shared/Resources/integration-logos-manifest.json`.

If the service is not on Simple Icons, source or create an SVG and convert it the same way. The result must be a true vector PDF (not a rasterized image wrapped in PDF) so it scales cleanly.

The `logoUrl` field in `seed-providers.ts` still serves as the remote fallback (typically a Simple Icons CDN URL like `https://cdn.simpleicons.org/acme`). The client renders the local PDF first, then falls back to `logoUrl`, then to an initials avatar.

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
