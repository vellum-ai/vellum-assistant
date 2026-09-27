---
name: add-mcp-integration
description: >
  Add a vendor's remote MCP server to the bundled integrations catalog
  (plugins/mcp-catalog/<name>/ + plugins/marketplace.json) so users can connect
  it from the Integrations page. Covers vetting the server's OAuth support, the
  icon, the package files, the generators, the CI checks, and the PR. Use when
  asked to "add <vendor> MCP", "add <vendor> to integrations", or to check
  whether a vendor's MCP server is an easy addition.
---

# Add an MCP Integration

A catalog integration is a bundled local plugin whose only content is an
`mcp.json` pointing at the vendor's remote server. The assistant ships it, the
Integrations page lists it, and connecting it runs the MCP OAuth flow in
`assistant/src/mcp/mcp-oauth-provider.ts`.

Scope: remote MCP servers in `plugins/mcp-catalog/`. For a full plugin that
lives in another GitHub repo, see `plugins/README.md` § Marketplace.

Work in a worktree from `origin/main`. One provider per PR.

## 1. Research the server

From the vendor's MCP docs, record:

- The remote URL. Prefer `streamable-http` (docs often say `"type": "http"`).
- The docs page URL. It is both `homepage` and `documentationUrl`.
- A one-line summary of what the tools do.

Reject a server that only runs locally (`npx`, `uvx`, Docker). The catalog
ships no stdio servers.

## 2. Check OAuth support

The catalog's one-step connect needs the server to support OAuth discovery and
dynamic client registration (DCR), because a plugin cannot ship a client
secret.

```bash
URL=https://mcp.example.com/mcp
curl -sS -i -X POST "$URL" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

Expect `401` with `WWW-Authenticate: Bearer ... resource_metadata="<url>"`.
Fetch that URL and take `authorization_servers[0]` as the issuer. Then fetch
the issuer's metadata from the first URL that answers, in the order the MCP
SDK tries them (`buildDiscoveryUrls` in `@modelcontextprotocol/sdk`
`client/auth.js`):

| Issuer                             | Metadata URLs, in order                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://auth.example.com`         | `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration`                                                                                            |
| `https://auth.example.com/tenant1` | `/.well-known/oauth-authorization-server/tenant1`, then `/.well-known/openid-configuration/tenant1`, then `/tenant1/.well-known/openid-configuration` (all on the issuer host) |

Check the metadata the way the SDK does:

| Field                              | Rule                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `registration_endpoint`            | Must be present. The SDK stops with "does not support dynamic client registration" without it.   |
| `code_challenge_methods_supported` | If present, must include `S256`. Absent is fine.                                                 |
| `response_types_supported`         | Must include `code`.                                                                             |
| `grant_types_supported`            | Should include `refresh_token`. Without it, users sign in again each time the access token ends. |

Do not judge `token_endpoint_auth_methods_supported` from the metadata. The
registration in step 3 shows which method the server gives our public client.

Pick the setup mode:

- **The rules hold and step 3 succeeds:** `oauth`. The normal case.
- **DCR works, but the vendor must allowlist our redirect URI first:** `manual`.
  `ramp` is the example. Its `setup.instructions` tell the user what to ask
  the vendor for.
- **No `registration_endpoint`, or step 3 only returns a confidential client
  (a `client_secret` and a `client_secret_*` auth method):** not a catalog
  addition. It needs a pre-registered client, which the MCP OAuth flow does
  not support. Stop and report this.

Also check whether the vendor already has a main OAuth provider in
`assistant/src/oauth/seed-providers.ts`. If it does, set `integration.oauthProvider` so the
Integrations page groups both connections (see `calendly`, `linear`, `notion`,
`todoist`).

## 3. Test registration

Register a throwaway client with the same shape as
`McpOAuthProvider.clientMetadata`:

```bash
curl -sS -X POST <registration_endpoint> -H 'content-type: application/json' \
  -d '{"client_name":"Vellum Assistant (registration probe)","redirect_uris":["https://example.com/webhooks/oauth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"logo_uri":"https://www.vellum.ai/favicon.ico","software_version":"0.0.0"}'
```

A `client_id` with `token_endpoint_auth_method: "none"` in the response means
the server registers public clients.

This probe does not prove the vendor accepts our real redirect URI. Each
assistant resolves its own callback (`resolveOauthCallbackUrl` in
`assistant/src/inbound/oauth-callback-url.ts`), and a vendor can restrict
redirect hosts. If you know the callback URL of the assistant you will test
with, register that instead of `example.com`. If the `example.com` probe is
rejected for its redirect URI, retry with a real callback before you reject
the server. Step 9 is the real test of the redirect.

## 4. Icon

Write `plugins/mcp-catalog/<name>/icon.png`: a PNG, 128x128, on an opaque white
background so it reads on the dark theme. The inventory test requires at
least 64x64.

Source, in order of preference:

1. The vendor's official asset (apple touch icon, a large favicon, a press kit).
2. Simple Icons, pinned to a commit URL, rasterized in the brand color.

```bash
magick <source> -resize 128x128 -background white -alpha remove -alpha off -strip PNG24:plugins/mcp-catalog/<name>/icon.png
```

Look at the result with the Read tool before you continue.

Write `ICON_ATTRIBUTION.md` beside it in the same form as the others: source
link, what was done to it, and "It is a trademark of <Vendor> and is used only
to identify this integration." `circleback`, `craft`, and `wix` show the
official-asset form. `atlassian` shows the Simple Icons form.

## 5. Package files

`plugins/mcp-catalog/<name>/plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "<name>",
  "version": "1.0.2",
  "description": "<Verb-first summary, under about 60 characters.>",
  "homepage": "<MCP docs URL>",
  "license": "MIT"
}
```

`plugins/mcp-catalog/<name>/mcp.json`. The server key must equal `<name>`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "<name>": { "type": "streamable-http", "url": "<remote URL>" }
  }
}
```

Append an entry to `plugins/marketplace.json` after the last local entry:

```json
{
  "name": "<name>",
  "source": {
    "source": "local",
    "path": "plugins/mcp-catalog/<name>",
    "version": "<plugin.json version>"
  },
  "description": "<same as plugin.json>",
  "homepage": "<MCP docs URL>",
  "license": "MIT",
  "integration": {
    "kind": "mcp",
    "displayName": "<Vendor>",
    "documentationUrl": "<MCP docs URL>",
    "verifiedAt": "<today, YYYY-MM-DD>",
    "verification": "documentation-only",
    "setup": {
      "mode": "oauth",
      "instructions": "<One sentence: which account to sign in with.>"
    },
    "logo": "<name>-mcp.png",
    "category": "<slug>"
  }
}
```

- `category` must be a slug from `INTEGRATION_CATEGORIES` in
  `packages/service-contracts/src/integration-categories.ts`.
- `homepage` is the MCP docs URL, not the vendor's home page. Every catalog
  entry follows this.
- No em dashes in any copy. Users read `description` and `instructions`.

## 6. Run the generators

From the repo root, in this order:

```bash
node scripts/plugins/sync-local-plugin-icons.mjs              # web copy: clients/web/public/images/integrations/<name>-mcp.png
node scripts/plugins/generate-plugin-icons.mjs                # platform copy: plugins/assets/<name>/icon.png + plugins/plugin-icons.json
bun run meta/sync-bundled-copies.ts                           # bundled offline marketplace copy
bun run assistant/scripts/generate-bundled-plugin-packages.ts # bundled package map
```

`git status` must show changes for `<name>` only.

## 7. Update the inventory test

In `scripts/plugins/__tests__/mcp-marketplace-inventory.test.ts`:

- Add `<name>` to `EXPECTED_PROVIDERS`.
- Increase the provider count in the test title.
- Increase the `oauth` count, or change the `manual` assertion.
- Add to the `oauthProvider` map if you set one.

## 8. Run the CI checks

These are the steps of `.github/workflows/pr-marketplace.yaml`:

```bash
node scripts/check-marketplace-prefix.mjs
bun run meta/sync-bundled-copies.ts --check
bun run assistant/scripts/generate-bundled-plugin-packages.ts --check
node scripts/plugins/generate-plugin-icons.mjs --check
node scripts/plugins/sync-local-plugin-icons.mjs --check
(cd scripts && bun test plugins/__tests__/bundled-plugin-packages.test.ts plugins/__tests__/mcp-marketplace-inventory.test.ts plugins/__tests__/add-plugin-icon.test.mjs plugins/__tests__/generate-plugin-icons.test.mjs plugins/__tests__/sync-local-plugin-icons.test.mjs)
```

## 9. Test end to end

Needs an account with the vendor. On an assistant built from the branch (see
the `cli-testing` skill, or a platform preview):

1. Open Integrations, find the tile, and connect. Finish the vendor sign-in.
2. Confirm it shows as connected. `assistant mcp list` shows the server.
3. Ask the assistant for something that calls one of the server's tools (for
   example, "list my <vendor> projects") and confirm a real result.

If nobody can test this before the next release, add `<name>` to
`MCP_CATALOG_QA_INTEGRATION_NAMES` in
`assistant/src/cli/lib/plugin-catalog-visibility.ts`, and add the vendor to
the `mcp-catalog-qa-integrations` description in
`meta/feature-flags/feature-flag-registry.json` and
`clients/web/src/lib/feature-flags/feature-flag-registry.json`. Then the entry
stays hidden until it passes QA.

The flag key and default do not change, so this needs no platform Terraform
change. Check its row in `meta/feature-flags/PENDING_PLATFORM_PRS.md`: while
the flag is not provisioned, nobody can turn it on remotely, so QA uses a local
flag override.

## 10. Open the PR

- Title: `feat(marketplace): add the <Vendor> MCP server to the integrations catalog`.
- In the body, show the OAuth evidence from steps 2 and 3, the icon source, and
  the step 8 commands.
- Leave step 9 unchecked in the test plan if it was not done, and say why.
