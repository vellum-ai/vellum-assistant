# Bundled Skill CLI Retrieval Pattern

When running the `assistant` CLI, run it using the `bash` (not `host_bash`) tool.

For account and auth workflows, prefer documented `assistant` CLI commands over
any generic account registry:

- `assistant credentials list` for discovering stored credential handles
- `assistant oauth status <provider>` for discovering OAuth connection handles
- `assistant credentials set ...` for storing new credentials
- `assistant mcp auth <name>` when an MCP server needs browser login
- `assistant platform status` for platform-linked deployment/auth context

If a bundled skill documents a service-specific `assistant <service>` auth or
session flow, follow that CLI exactly.

# Authenticated Outbound Requests

When a skill needs outbound API calls with a stored credential, use the `bash` tool in
proxied mode instead of extracting raw tokens into shell commands. The credential is injected
into the request through the egress proxy without exposing the secret value to the assistant:

1. Discover the credential handle: `assistant credentials list --search <service>`
2. Run the request with `bash` using `network_mode: "proxied"` and `credential_ids: [<handle>]`.
   The proxy attaches the credential to matching outbound requests and enforces the credential's
   allowed-domains policy.

Note: `host_bash` is approval-gated and runs outside the proxied-credential boundary. Do not use
`host_bash` to pass raw credentials to shell commands. Route authenticated work through `bash`
with `network_mode: "proxied"`.
