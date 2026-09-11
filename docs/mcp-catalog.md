# MCP integration catalog

New catalog integrations use the [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification), with root `plugin.json` and `mcp.json` documents. The standard documents are the connection definition. The curation index contains presentation and source metadata, never another copy of the endpoint or transport.

Existing installed plugins keep their existing loader, files, install fingerprints, names, storage, and credentials. This catalog reader is explicitly called only by catalog tooling and connections. Finding standard filenames in an existing plugin does not select it. Connecting a catalog definition creates a workspace-owned MCP connection; it does not install skills, hooks, commands, dependencies, or executable code.

## Adding a reviewed definition

1. Use a provider-owned standard package when available; otherwise author minimal standard documents from the provider's official documentation.
2. Store the reviewed documents under `plugins/mcp-catalog/<id>/`. Include the canonical versioned `$schema` identifier in both documents.
3. Add an entry to `plugins/mcp-catalog.json` identifying `packagePath`, `serverKey`, display metadata, setup requirements, documentation URL, and review date.
4. Set `verification` to `documentation-only` until authenticated testing succeeds; use `setup.mode: "manual"` when additional provisioning is required.
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
