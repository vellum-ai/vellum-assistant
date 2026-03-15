# Credential Execution Service (CES) — Architecture Decision Record

## Status

**Accepted** — locked decisions below are final for the initial implementation.

## Context

Untrusted agents (managed assistants, delegated workers, third-party skill invocations) need to execute credential-bearing operations (API calls, CLI commands, browser automation with stored secrets) without the agent ever observing plaintext secret material. The existing credential broker (`assistant/src/tools/credentials/broker.ts`) operates inside the assistant process, which means the assistant runtime has theoretical access to secret values during brokered use. For local single-user deployments this is acceptable, but for managed multi-tenant and untrusted-agent scenarios, a stronger isolation boundary is required.

## Decision

Introduce the **Credential Execution Service (CES)** as a hard-boundary sidecar that is the only trusted component allowed to materialize credentials for execution.

### Core Design Principles

1. **Separate package**: CES lives in a new top-level `credential-executor/` package in the monorepo. There are **no direct source imports from `assistant/` to `credential-executor/` or vice versa.** Communication is exclusively via RPC (see transports below).

2. **Separate managed image**: In managed deployments, CES runs as its own container image, distinct from the assistant runtime image and the gateway image. This means managed rollout requires a **third runtime image** and corresponding `vembda` pod-template changes.

3. **CES-owned durable state**: Grants (which credentials a given agent session is authorized to use, under what constraints) and audit logs (which credentials were materialized, when, by whom, for what purpose) are **CES-owned durable state**. The assistant does not read or write grant tables directly. Grant lifecycle is managed entirely through CES RPC.

4. **Assistant-to-CES RPC only**: The assistant sends execution requests to CES; CES materializes the credential, executes the operation in its own sandbox, and returns the result (stdout/stderr/exit code, HTTP response body, etc.) to the assistant. The assistant never sees the plaintext credential value.

## Transports

CES supports two transport modes, selected based on deployment topology:

### Local child-process transport (stdio)

For local single-user and development deployments, the assistant spawns CES as a child process and communicates over stdin/stdout using newline-delimited JSON-RPC. The assistant is responsible for the CES process lifecycle (start, health check, restart, shutdown).

### Managed sidecar transport (Unix socket)

For managed multi-tenant deployments, CES runs as a sidecar container in the same pod. Communication occurs over a **bootstrap Unix socket** mounted at a well-known path in a shared `emptyDir` volume. The sidecar starts independently and the assistant connects to the socket on startup.

## CES Tools

CES exposes exactly three tools to the assistant, registered as a **deliberate exception** to the skill-first tool direction (see `AGENTS.md` and `assistant/src/tools/AGENTS.md`). These tools are not skills because they require hard process-boundary isolation that skill scripts cannot provide.

| Tool                     | Purpose                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ces_run_command`        | Execute a shell command with credential environment variables injected by CES. The credential values are set in the CES process environment only — never transmitted to the assistant.      |
| `ces_authenticated_http` | Execute an HTTP request with credential-bearing headers/auth injected by CES. CES performs the HTTP call and returns the response body and status to the assistant.                         |
| `ces_browser_fill`       | Fill a browser form field with a credential value. CES connects to the browser automation endpoint and injects the secret directly — the value never appears in assistant-side tool output. |

### Tool registration

CES tools use the standard `class ... implements Tool` registration pattern. This is explicitly approved as a deliberate exception to the no-new-tools policy because:

- The security boundary requires that credential materialization happens in a separate process
- Skill scripts run inside the assistant process and cannot enforce the hard isolation invariant
- The tools are thin RPC stubs; the actual logic lives in the `credential-executor/` package

## Locked Decisions

### 1. `host_bash` is outside the strong secrecy guarantee

The existing `host_bash` tool executes commands on the host machine without any credential isolation. When an agent uses `host_bash`, it has full access to the host environment, including any credentials stored in environment variables, config files, or keychains accessible to the user. CES does not attempt to intercept or sandbox `host_bash` invocations.

**Implication**: `host_bash` represents a weaker security tier. Agents that require the strong secrecy guarantee must use `ces_run_command` instead. Trust rules and permission policies should reflect this distinction — managed deployments may deny `host_bash` entirely for untrusted agents while allowing `ces_run_command`.

### 2. Managed static secrets remain on the assistant data volume for v1

For the initial implementation, managed static secrets (API keys, tokens stored via the credential store) remain on the assistant's data volume (`~/.vellum/protected/`). CES reads them at materialization time via a read-only volume mount (managed) or direct filesystem access (local).

This is a pragmatic v1 decision. Future iterations may move secret storage to a dedicated secret manager (e.g., cloud KMS, Vault) with CES as the only authorized reader.

### 3. Platform OAuth materialization stays on the platform

OAuth tokens managed by the platform (`vellum-assistant-platform`) — including token refresh, revocation, and scope management — continue to be handled by the platform's token management system. CES does not duplicate OAuth lifecycle management. When CES needs an OAuth token, it requests a materialized token from the platform via the existing platform proxy endpoint, using the same mechanism the assistant currently uses.

### 4. Secure generic authenticated HTTP must not run through `run_authenticated_command`

The existing `run_authenticated_command` pattern (used by the script proxy for credentialed bash commands) must not be used as the transport for generic authenticated HTTP requests. `ces_authenticated_http` is a purpose-built tool that:

- Validates the target URL against the credential's allowed-domains policy before materializing
- Does not expose a shell execution surface (no command injection vector)
- Returns only the HTTP response body and status, not raw shell output
- Produces a structured audit log entry with URL, method, and credential ID (not raw command text)

Routing HTTP requests through shell commands (`curl` with credential env vars via `run_authenticated_command`) would bypass domain validation and produce inferior audit trails.

## Grant Persistence

CES manages its own grant table, separate from the assistant's `scoped_approval_grants` table. CES grants answer a different question: "Is this agent session authorized to use credential X for purpose Y?" rather than "Did a guardian approve this specific tool invocation?"

| Field              | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `grant_id`         | Unique identifier                                                          |
| `session_id`       | The agent session that holds this grant                                    |
| `credential_id`    | Which credential is authorized                                             |
| `allowed_purposes` | Constrained set of purposes (e.g., specific API endpoints, specific tools) |
| `created_at`       | When the grant was minted                                                  |
| `expires_at`       | TTL-based expiry                                                           |
| `consumed_at`      | When the grant was used (null if unused)                                   |
| `revoked_at`       | When the grant was revoked (null if active)                                |

Audit logs record every materialization event with: grant ID, credential ID, tool name, target (URL/command/form field), timestamp, and outcome (success/failure).

## Deployment Topology

### Local

```
┌─────────────────────────────────────┐
│  assistant (Bun)                    │
│  ├── spawns CES as child process    │
│  └── communicates via stdio JSON-RPC│
│       │                             │
│       ▼                             │
│  credential-executor (Bun)          │
│  ├── reads secrets from filesystem  │
│  ├── executes credentialed commands │
│  └── owns grant + audit tables     │
└─────────────────────────────────────┘
```

### Managed (pod)

```
┌─────────────────────────────────────────┐
│  Pod                                    │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  assistant    │  │  CES sidecar    │  │
│  │  container    │  │  container      │  │
│  │              ◄──►  (own image)     │  │
│  │  (Unix sock) │  │                  │  │
│  └──────────────┘  └─────────────────┘  │
│         │                   │            │
│         ▼                   ▼            │
│  ┌─────────────────────────────────┐    │
│  │  shared emptyDir volume         │    │
│  │  └── /run/ces/ces.sock          │    │
│  └─────────────────────────────────┘    │
│         │                               │
│         ▼                               │
│  ┌─────────────────────────────────┐    │
│  │  assistant data volume (RO)     │    │
│  │  └── secrets (read-only mount)  │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

## Boundary Invariants

These invariants are enforced by guard tests and code review:

1. **No cross-package source imports**: `assistant/` must not import from `credential-executor/` and vice versa. Communication is RPC only.
2. **No credential values in assistant process memory**: The assistant sends credential IDs (not values) to CES. CES materializes and uses them internally.
3. **CES tools are the only approved exception to the no-new-tools policy** for credential-bearing execution. All other credential use continues through the existing broker for local deployments.
4. **Grants and audit logs are CES-internal**: The assistant cannot read CES grant tables or audit logs directly. CES exposes grant status via RPC responses (e.g., "grant valid" / "grant expired").

## See Also

- [Security architecture](architecture/security.md) — existing credential broker and permission model
- [AGENTS.md](../../AGENTS.md) — tooling direction and CES exception
- [Tools AGENTS.md](../src/tools/AGENTS.md) — no-new-tools policy and CES exception
