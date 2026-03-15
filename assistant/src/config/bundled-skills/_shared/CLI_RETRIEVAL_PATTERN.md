# Bundled Skill CLI Retrieval Pattern

When running the `assistant` CLI, run it using the `bash` (not `host_bash`) tool.

For account and auth workflows, prefer documented `assistant` CLI commands over
any generic account registry:

- `assistant credentials list` for discovering stored credential handles
- `assistant oauth connections list` for discovering OAuth connection handles
- `assistant credentials set ...` for storing new credentials
- `assistant mcp auth <name>` when an MCP server needs browser login
- `assistant platform status` for platform-linked deployment/auth context

If a bundled skill documents a service-specific `assistant <service>` auth or
session flow, follow that CLI exactly.

# Authenticated Outbound Requests

When a skill needs outbound API calls with a stored credential, use CES tools instead of
extracting raw tokens into shell commands. CES injects credentials securely without exposing
secrets to the assistant:

1. Discover the credential handle: `assistant credentials list --search <service>`
2. Use the appropriate CES tool:
   - `make_authenticated_request` for HTTP API calls (CES injects auth and returns the response)
   - `run_authenticated_command` for CLI commands needing credential env vars (runs in CES sandbox)

Note: `host_bash` is approval-gated and runs outside the CES secrecy boundary. Do not use
`host_bash` to pass raw credentials to shell commands. Route authenticated work through CES tools.
