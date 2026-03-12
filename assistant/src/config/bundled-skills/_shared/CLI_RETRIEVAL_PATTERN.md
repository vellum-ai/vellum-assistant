# Bundled Skill CLI Retrieval Pattern

When running the `assistant` CLI, run it using the `bash` (not `host_bash`) tool.

For account and auth workflows, prefer documented `assistant` CLI commands over
any generic account registry:

- `assistant credentials ...` for stored secrets and credential metadata
- `assistant oauth connections token <service>` for OAuth-backed integrations
- `assistant mcp auth <name>` when an MCP server needs browser login
- `assistant platform status` for platform-linked deployment/auth context

If a bundled skill documents a service-specific `assistant <service>` auth or
session flow, follow that CLI exactly.

# Outbound Network Requests

When a skill needs outbound API calls with a stored credential (outside of `assistant` CLI reads), use proxied `bash`:

```yaml
bash:
  network_mode: proxied
  credential_ids:
    - "<credential-id>"
  command: |
    curl -s https://api.example.com/resource
```
