# MCP integration catalog

New catalog integrations use the [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification), with root `plugin.json` and `mcp.json` documents. The standard documents are the connection definition. The curation index contains presentation and source metadata, never another copy of the endpoint or transport.

Existing installed plugins keep their existing loader, files, install fingerprints, names, storage, and credentials. This catalog reader is explicitly called only by catalog tooling and connections. Finding standard filenames in an existing plugin does not select it. Connecting a catalog definition creates a workspace-owned MCP connection; it does not install skills, hooks, commands, dependencies, or executable code.

## Adding a reviewed definition

1. Use a provider-owned standard package when available; otherwise author minimal standard documents from the provider's official documentation.
2. Store the reviewed documents under `plugins/mcp-catalog/<id>/`. Include the canonical versioned `$schema` identifier in both documents.
3. Add an entry to `plugins/mcp-catalog.json` identifying `packagePath`, `serverKey`, display metadata, setup requirements, documentation URL, and review date.
4. Set `verification` to `documentation-only` until authenticated testing succeeds; use `setup.mode: "manual"` for callback allowlisting. Providers requiring additional authentication or runtime capabilities are deferred for a separate architecture review.
5. Generate and check the bundle:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun scripts/plugins/generate-mcp-catalog.ts
bun scripts/plugins/generate-mcp-catalog.ts --check
```

Example standard documents:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example"
}
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "example": {
      "type": "streamable-http",
      "url": "https://api.example.com/mcp"
    }
  }
}
```

Example curation entry:

```json
{
  "id": "example",
  "packagePath": "plugins/mcp-catalog/example",
  "serverKey": "example",
  "source": { "kind": "local" },
  "displayName": "Example",
  "description": "Search project records.",
  "documentationUrl": "https://docs.example.com/mcp",
  "verifiedAt": "2026-09-10",
  "verification": "documentation-only",
  "setup": { "mode": "oauth" }
}
```

`source.kind: "local"` denotes a Vellum-authored package. For reviewed provider packages, use `source.kind: "github"`, `repository` matching the existing marketplace GitHub source shape, and `definitionDigest`; or use `source.kind: "marketplace"`, `name`, and `definitionDigest` to reuse the existing marketplace pin. External refs must be full commit SHAs. Vendor only the two standard documents from that revision and review their provenance before updating the digest. `standardDefinitionDigest()` hashes the parsed standard documents; the generator verifies it for external sources. Neither generation nor check mode downloads anything. `resolvedSource` in generated data records the marketplace coordinates used for that build.

Optional `oauthProvider` groups explicitly reviewed OAuth alternatives; absence means no inferred grouping. Optional `icon` references a bundled integration image by identifier. `setup.instructions` describes provider prerequisites.

## Validation and runtime boundary

The local validator recognizes the official versioned [manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json). The specification's loading rules take precedence over whole-document JSON Schema validation: unknown manifest fields and malformed extension containers are reported and ignored; malformed server siblings are reported and skipped. Unknown schema versions and invalid root manifests fail the catalog package. There is no fallback to the installed-plugin parser.

The catalog supports Streamable HTTP. Valid stdio/SSE definitions are reported as unsupported and are never executed. Existing custom and plugin stdio/SSE connections are unaffected. Package and document real paths must stay inside their reviewed roots. File reads are bounded, no install hooks run, no credentials expand, and no schemas are fetched while loading.

Standard URL and header fields remain intact. Remote URLs require HTTPS except loopback HTTP and cannot include user information or fragments. Header names are case-insensitive and cannot repeat; credentials must never be committed in headers. Connection code must keep client-generated authorization/MCP headers authoritative and must not forward configured headers to another origin without authorization.

The generated `assistant/src/mcp/bundled-catalog.json` contains standard documents plus curation metadata and definition digests. The same inputs produce the same bytes, and `--check` detects drift. Catalog reads do not connect providers. Catalog updates ship with an assistant release; existing saved connections retain their selected endpoint and identity independently of later catalog changes.

## Provider evidence

Reviewed on 2026-09-10. Entries are marked `documentation-only`. Each curation entry links its official provider documentation and records prerequisites. OAuth metadata checks establish compatibility with public-client registration where documented; they do not establish account entitlement or successful authorization. Auth return, authenticated tool listing, safe read operations, credential cleanup, and reconnect have **not** been exercised against provider accounts. No provider credentials were used or copied into the catalog.

The original provider set has these sources:

| Provider  | Official setup evidence                                                                                                              | Catalog treatment                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Fathom    | [MCP overview](https://developers.fathom.ai/mcp-docs) and [authorization instructions](https://developers.fathom.ai/mcp-docs/claude) | Browser authorization; Vellum-authored standard documents.                                                                       |
| Brex      | [Brex MCP setup and access controls](https://www.brex.com/support/using-brex-in-ai-apps)                                             | OAuth; show the admin enablement and Developer API agreement prerequisite.                                                       |
| Ramp      | [Custom MCP connection guide](https://agents.ramp.com/docs/guides/connecting)                                                        | Setup required: custom client/gateway redirect URIs must be allowlisted by Ramp before authorization.                            |
| Linear    | [MCP setup](https://linear.app/docs/mcp)                                                                                             | OAuth; explicit grouping with the existing Linear OAuth provider.                                                                |
| Notion    | [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)                                               | OAuth; explicit grouping with the existing Notion OAuth provider.                                                                |
| Sentry    | [Official Sentry MCP repository](https://github.com/getsentry/sentry-mcp)                                                            | OAuth; uses the hosted remote service.                                                                                           |
| Stripe    | [MCP setup and access management](https://docs.stripe.com/mcp)                                                                       | OAuth; account/environment and administrator restrictions apply; separate from Stripe Link.                                      |
| Atlassian | [Official package and current setup](https://atlassian.github.io/atlassian-mcp-server/)                                              | Vendor the provider's standard documents at commit `9de1ab435251042efbb6839a1ca748eacecf4727`, including its Apache-2.0 license. |

Packages without a provider-published standard source are minimal Vellum-authored standard documents derived from official provider documentation. The endpoint lives only in each package's `mcp.json`; the generated bundle is derived from it. The [Cursor provider inventory at a pinned revision](https://github.com/cursor/plugins/tree/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d/third_party) supplies research leads only. The runtime and generator do not read that repository, adapt its format, use its OAuth client registrations, or install its packages.

### Coverage boundaries

The inventory contains 61 MCP options. The catalog includes 32 of them plus the six original providers absent from that inventory: Atlassian, Linear, Notion, Ramp, Sentry, and Stripe, for 38 entries in total. The expansion adds 30 presets through the existing OAuth connection flow. The remaining 29 are deferred for validation or architecture review:

| Options | Required work |
| --- | --- |
| Ahrefs, Daloopa | Validate registration compatibility: the metadata omits refresh-token grants, which Vellum requests when registering its client. No registration test was performed. |
| Brevo, GitHub, Hunter, Similarweb, Smartsheet, Wrike | Decide how catalog setup should collect and securely bind static tokens already supported by custom MCP connections. |
| Excalidraw, GoDaddy | Decide how unauthenticated providers should be represented in catalog setup; the current modes describe OAuth flows. |
| [Gmail, Google Calendar, Google Drive](https://developers.google.com/workspace/guides/configure-mcp-servers) | Provision a Vellum OAuth client and support Google's client authentication. Discovery does not advertise dynamic registration or public-client token authentication. |
| [Coda](https://help.superhuman.com/hc/en-us/articles/46210076980365-Connect-to-the-Coda-MCP), [S&P Global](https://docs.kensho.com/llmreadyapi/overview) | Support confidential-client token authentication. Their discovery metadata advertises registration but requires client-secret authentication. |
| [Docusign](https://developers.docusign.com/platform/mcp-server/), [Gong](https://help.gong.io/docs/about-gong-mcp-server), [HubSpot](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server), [Zoom](https://developers.zoom.us/docs/mcp/) | Support provider client registration, callback setup, and securely stored OAuth client credentials. |
| [X](https://docs.x.com/tools/mcp), [X Ads](https://docs.x.com/x-ads-api/introduction) | Obtain Vellum-owned client registrations and configure their scopes; another application's client IDs cannot be reused. |
| [Salesforce](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/cursor.html) | Collect the organization's MCP URL, External Client App consumer key, and scopes. |
| [Playwright](https://github.com/microsoft/playwright-mcp), [Xero](https://github.com/XeroAPI/xero-mcp-server) | Add catalog-managed stdio setup, package execution, and, for Xero, secure Custom Connection credentials. Existing custom/plugin stdio remains supported. |
| [Workable](https://workable.readme.io/reference/workable-mcp-server) | Obtain provider approval for Vellum's callback URL. |
| OneDrive, Outlook, Outlook Calendar, Teams | The inventory uses Cursor-hosted intermediaries. A provider-owned MCP endpoint or a separately implemented Vellum Microsoft Graph MCP service is required; no Cursor service URL is bundled. |

Existing OAuth alternatives remain available independently. Their availability does not imply MCP support for the same provider.

### Local QA

Catalog data is bundled with the assistant. Switching the web checkout's branch can update the UI while an already-running local assistant still serves older code. If the unified UI appears without catalog options, check the assistant and gateway process start times against the branch switch, then restart those services and reload the page. The catalog endpoint returning 404 denotes an older assistant; a successful response advertises `supportsConnect: true`.

For a managed local instance, `vellum sleep <name> --wait` waits for active work before stopping it; use `vellum wake <name>` afterward. A bounded `--wait 60s` proceeds with stopping when its deadline expires, so it is not a safe timeout when active work must remain uninterrupted. `vel up` can reuse an already-running assistant.

[Asana's v2 client setup](https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server) requires registered client credentials, so Asana MCP is omitted until that provisioning is supported. Existing Asana OAuth remains available.

Before marking a provider `tested`, record discovery, browser return, tool listing, one authorized safe read, disconnect cleanup, and reconnect using a dedicated test account. Missing test accounts do not imply compatibility.

Bundled branding is preferred over network images. Custom connections may try their public HTTPS DNS origin's `/favicon.ico` with no referrer; endpoint paths, query strings, fragments, IP literals, and known private hostnames are excluded. This is a browser image request, not a server fetch or third-party favicon service. DNS is not resolved in the renderer, so public-looking hostnames are only a best-effort classification. Missing or broken images retain the generic plugin icon and fixed dimensions. Sources are recorded in [logo attribution](../clients/web/public/images/integrations/ATTRIBUTION.md).
