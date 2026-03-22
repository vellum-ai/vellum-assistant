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

3. **CES-owned durable state**: Grants (which credentials are authorized for use, under what constraints) and audit logs (which credentials were materialized, when, by whom, for what purpose) are **CES-owned durable state**. The assistant does not read or write grant tables directly. Grant lifecycle is managed entirely through CES RPC.

4. **Assistant-to-CES RPC only**: The assistant sends execution requests to CES; CES materializes the credential, executes the operation in its own sandbox, and returns the result (stdout/stderr/exit code, HTTP response body, etc.) to the assistant. The assistant never sees the plaintext credential value.

## Transports

CES supports two transport modes, selected based on deployment topology:

### Local child-process transport (stdio)

For local single-user and development deployments, the assistant spawns CES as a child process and communicates over stdin/stdout using newline-delimited JSON-RPC. The assistant is responsible for the CES process lifecycle (start, health check, restart, shutdown).

### Managed sidecar transport (Unix socket)

For managed multi-tenant deployments, CES runs as a sidecar container in the same pod. Communication occurs over a **bootstrap Unix socket** mounted at a well-known path in a shared `emptyDir` volume. The sidecar starts independently and the assistant connects to the socket on startup.

## CES Tools

CES exposes exactly three tools to the assistant, registered as a **deliberate exception** to the skill-first tool direction (see `AGENTS.md` and `assistant/src/tools/AGENTS.md`). These tools are not skills because they require hard process-boundary isolation that skill scripts cannot provide.

| Tool                         | Purpose                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_authenticated_command`  | Execute a shell command with credential environment variables injected by CES. The credential values are set in the CES process environment only — never transmitted to the assistant. |
| `make_authenticated_request` | Execute an HTTP request with credential-bearing headers/auth injected by CES. CES performs the HTTP call and returns the response body and status to the assistant.                    |
| `manage_secure_command_tool` | Register and manage secure command tool bundles in the CES toolstore. Handles bundle lifecycle (registration, unregistration) for manifest-driven credential-bearing commands.         |

### Tool registration

CES tools use the standard `class ... implements Tool` registration pattern. These are justified exceptions to the general preference for skills because:

- The security boundary requires that credential materialization happens in a separate process
- Skill scripts run inside the assistant process and cannot enforce the hard isolation invariant
- The tools are thin RPC stubs; the actual logic lives in the `credential-executor/` package

## Locked Decisions

### 1. `host_bash` is outside the strong secrecy guarantee

The existing `host_bash` tool executes commands on the host machine without any credential isolation. When an agent uses `host_bash`, it has full access to the host environment, including any credentials stored in environment variables, config files, or keychains accessible to the user. CES does not attempt to intercept or sandbox `host_bash` invocations.

**Implication**: `host_bash` represents a weaker security tier. Agents that require the strong secrecy guarantee must use `run_authenticated_command` instead. Trust rules and permission policies should reflect this distinction — managed deployments may deny `host_bash` entirely for untrusted agents while allowing `run_authenticated_command`.

### 2. Local static secrets are local-mode only — by policy

For the current implementation, local static secrets (API keys, tokens stored via the credential store in `~/.vellum/protected/`) are only accessible to CES in **local mode**, where CES runs as a child process of the assistant. CES reads them at materialization time via direct filesystem access.

In **managed mode**, `local_static` handles are not supported and the CES returns a clear error for any `local_static` handle. Managed deployments use `platform_oauth` handles exclusively. With v2 `store.key`, this is a **policy choice** (simpler lifecycle, centralized token management) rather than a technical limitation — the UID-independent key file could be shared via volume mount.

#### Historical: v1 key derivation blocker (resolved in v2)

The v1 encrypted key store uses PBKDF2 key derivation where the encryption key is derived from `userInfo().username` and `userInfo().homedir`. In managed deployments the assistant and CES sidecar run as different OS users, producing different derived keys — making it impossible for CES to decrypt secrets stored by the assistant.

v2 stores replaced PBKDF2 derivation with a random 32-byte key stored at `<vellumRoot>/protected/store.key`. This key is UID-independent and can be shared via volume mount, removing the technical barrier to `local_static` in managed mode.

The policy decision to use `platform_oauth` exclusively in managed mode still stands for operational reasons: simpler credential lifecycle, centralized token management, and no need to synchronize key files across containers. Future iterations may enable `local_static` in managed mode via shared `store.key` volume mounts if there is a compelling use case.

#### Rejected alternatives (v1-era, historical context)

These alternatives were evaluated for the v1 key store and rejected. They are retained for historical context — the v2 `store.key` format resolves the underlying issue without hitting these trade-offs.

1. **Mount decrypted secrets into the CES container** — Breaks the "secrets never in assistant process memory" boundary (Boundary Invariant #2).

2. **Use shared key derivation independent of UID** — Was rejected for v1 because it weakened the encrypted-at-rest model. The v2 `store.key` approach achieves UID-independent decryption without the per-user identity trade-off, since the random key file is protected by filesystem permissions rather than derivation entropy.

3. **Pre-decrypt and pass via the RPC socket** — Violates the CES process-boundary isolation guarantee.

### 3. Platform OAuth materialization stays on the platform

OAuth tokens managed by the platform (`vellum-assistant-platform`) — including token refresh, revocation, and scope management — continue to be handled by the platform's token management system. CES does not duplicate OAuth lifecycle management. When CES needs an OAuth token, it requests a materialized token from the platform via the existing platform proxy endpoint, using the same mechanism the assistant currently uses.

### 4. Secure generic authenticated HTTP must not run through `run_authenticated_command`

The existing `run_authenticated_command` pattern (used by the script proxy for credentialed bash commands) must not be used as the transport for generic authenticated HTTP requests. `make_authenticated_request` is a purpose-built tool that:

- Validates the target URL against the credential's allowed-domains policy before materializing
- Does not expose a shell execution surface (no command injection vector)
- Returns only the HTTP response body and status, not raw shell output
- Produces a structured audit log entry with URL, method, and credential ID (not raw command text)

Routing HTTP requests through shell commands (`curl` with credential env vars via `run_authenticated_command`) would bypass domain validation and produce inferior audit trails.

## Grant Persistence

CES manages its own grant table, separate from the assistant's `scoped_approval_grants` table. CES grants answer: "Is credential X authorized for purpose Y?" rather than "Did a guardian approve this specific tool invocation?"

CES has two grant tiers:

- **Persistent grants** (`always_allow`): Stored in the CES grant table and scoped to the entire assistant — not to a specific session. These are analogous to trust rules: once a user approves `always_allow` for a credential+purpose pair, any session on that assistant can use the grant. The `session_id` field on persistent grants records which session created the grant (audit metadata), but is not used as an enforcement filter during grant matching.

- **Temporary grants** (`allow_once`, `allow_10m`, `allow_conversation`): Held in-memory by the CES process and scoped to the session or conversation that created them. These grants are not persisted and do not survive CES restarts. `allow_once` is consumed immediately after a single use; `allow_10m` expires after 10 minutes; `allow_conversation` is scoped to the originating conversation via key matching but remains in memory until the CES process restarts (there is no automatic cleanup on conversation end).

### Persistent grant table

| Field              | Purpose                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `grant_id`         | Unique identifier                                                                     |
| `session_id`       | The agent session that created this grant (audit metadata, not an enforcement filter) |
| `credential_id`    | Which credential is authorized                                                        |
| `allowed_purposes` | Constrained set of purposes (e.g., specific API endpoints, specific tools)            |
| `created_at`       | When the grant was minted                                                             |
| `expires_at`       | TTL-based expiry                                                                      |
| `consumed_at`      | When the grant was used (null if unused)                                              |
| `revoked_at`       | When the grant was revoked (null if active)                                           |

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
│  │  └── /run/ces-bootstrap/ces.sock │    │
│  └─────────────────────────────────┘    │
│         │                               │
│         ▼                               │
│  ┌─────────────────────────────────┐    │
│  │  assistant data volume (RO)     │    │
│  │  └── secrets (read-only mount)  │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

## Shared Private Packages

CES and the assistant share contract definitions and credential-storage abstractions through three private packages in `packages/`:

| Package                        | Purpose                                                                                                                   | Consumers                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `@vellumai/ces-contracts`      | RPC protocol types, method names, protocol version constant, grant shapes, credential handle types, and rendering helpers | `assistant/`, `credential-executor/` |
| `@vellumai/credential-storage` | Credential store read API (static secrets and OAuth runtime), unified credential handle abstraction                       | `assistant/`, `credential-executor/` |
| `@vellumai/egress-proxy`       | Session-scoped egress proxy lifecycle (create, start, stop, env-var injection)                                            | `assistant/`, `credential-executor/` |

These packages are the **only** allowed shared-code path between the assistant and CES. Direct source imports between `assistant/` and `credential-executor/` remain banned. The packages are built locally via `workspace:*` references and copied into the CES Docker image at build time (`COPY packages/ ...` in `credential-executor/Dockerfile`).

## Secure Command Auth Adapters

CES materializes credentials into the command execution environment through pluggable auth adapters. Each adapter type has different security properties:

| Adapter              | Mechanism                                                                                | Cleanup                                                              | Example                                                |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `env_var`            | Inject credential as an environment variable in the subprocess                           | Process-scoped; destroyed on exit                                    | `GH_TOKEN=<secret>`                                    |
| `temp_file`          | Write credential to a CES-managed temp file; set env var to the path                     | File deleted after command exits; mode clamped to `0600`             | `GOOGLE_APPLICATION_CREDENTIALS=/tmp/ces-xxx/svc.json` |
| `credential_process` | Spawn a helper inside CES that prints the credential to stdout; inject output as env var | Helper process terminated; output never exposed to the child command | AWS `credential_process` JSON output                   |

The adapter type is declared in the secure command manifest (`authAdapter` field). Validation rejects unknown adapter types and enforces constraints (e.g., `temp_file` mode must be <= `0600`, `credential_process` must specify a `helperCommand`).

**Invariant**: Generic authenticated HTTP clients (`curl`, `wget`, `httpie`) and interpreter trampolines (`bash`, `python`, `node`, etc.) are structurally denied as secure command entrypoints. The denied-binary list is checked both at manifest registration time and again at execution time (defense-in-depth).

## Egress Proxy Enforcement

Secure commands declare one of two egress modes:

| Mode             | Behavior                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy_required` | All network traffic must route through a CES-owned egress proxy session. `HTTP_PROXY`/`HTTPS_PROXY` env vars are injected. Each command profile must declare `allowedNetworkTargets` specifying host patterns, ports, and protocols.                                 |
| `no_network`     | The command has no network requirements. No proxy session is started. Network targets in profiles are rejected as contradictory. This is strictly more restrictive than `proxy_required` — the command receives dead-proxy env vars that block outbound connections. |

There is intentionally no `direct` or `unrestricted` egress mode. Commands that contact the network must go through the proxy so CES can enforce target allowlists and produce audit entries. Both modes are valid for command profiles; `no_network` is preferred when a command has no legitimate network needs.

**Important**: The `proxy_required` enforcement is **cooperative** — it relies on `HTTP_PROXY`/`HTTPS_PROXY` environment variable injection, not kernel-level network filtering. Binaries that ignore proxy environment variables, implement their own HTTP stacks, or open raw sockets can bypass the proxy allowlist entirely. See [Residual Risk #7](#7-cooperative-isolation-for-both-network-egress-and-filesystem-access) for the full risk analysis and mitigation strategy.

## Response Filtering (Defense-in-Depth)

HTTP responses returned to the assistant through `make_authenticated_request` pass through a sanitization pipeline:

1. **Header filtering** — Only whitelisted response headers (content metadata, rate-limit headers, pagination) are passed through. Auth-bearing headers (`set-cookie`, `www-authenticate`) are stripped.
2. **Body clamping** — Response bodies are truncated to 256 KB. The full body is never stored.
3. **Secret scrubbing** — Known credential values are replaced with `[CES:REDACTED]` in the response body. This catches APIs that echo back tokens.

**This is explicitly defense-in-depth, not the primary security control.** The primary protections are: (a) the process-boundary isolation that prevents the assistant from ever seeing credential values, (b) the grant system that restricts which credentials can be used, and (c) domain validation that restricts which targets can be contacted. Response filtering is a supplementary layer for APIs that leak secrets in response bodies.

## Boundary Invariants

These invariants are enforced by guard tests and code review:

1. **No cross-package source imports**: `assistant/` must not import from `credential-executor/` and vice versa. Communication is RPC only. Shared types flow through `packages/` only.
2. **No credential values in assistant process memory**: The assistant sends credential handles (not values) to CES. CES materializes and uses them internally.
3. **CES tools justify tool registrations over skills** for credential-bearing execution because of the hard process-boundary isolation requirement. All other credential use continues through the existing broker for local deployments.
4. **Grants and audit logs are CES-internal**: The assistant cannot read CES grant tables or audit logs directly. CES exposes grant status and audit summaries via RPC responses.
5. **No generic authenticated HTTP clients in secure commands**: `curl`, `wget`, `httpie`, interpreters, and shell trampolines are structurally denied as secure command entrypoints. This is checked at manifest validation and re-checked at execution time.
6. **Managed CES container runs as non-root**: The CES Docker image runs as `uid 1001` (user `ces`). The CES data volume is owned by this user.
7. **Single-connection bootstrap socket**: In managed mode, CES accepts exactly one connection on the bootstrap socket, then unlinks it. No second process can connect.

## Rollout

CES is rolled out incrementally via feature flags, all defaulting to `false` (off). The flags are ordered to allow progressive enablement without user-facing disruption.

### Feature flag order

Enable flags in this order. Each flag is safe to enable independently, but later flags depend on earlier ones being on for meaningful behavior.

| Order | Flag                                        | Gate                                                                                                                                                | Safe to enable alone?                                                                                                           |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `feature_flags.ces-tools.enabled`           | Register CES tools (`run_authenticated_command`, `make_authenticated_request`, `manage_secure_command_tool`) in the agent loop                      | Yes — tools register but are not invoked unless the agent discovers credentials that require CES                                |
| 2     | `feature_flags.ces-shell-lockdown.enabled`  | Enforce shell lockdown for untrusted agents with CES-active credentials; direct shell access to credentialed services is denied                     | Yes — only activates when CES credentials are present                                                                           |
| 3     | `feature_flags.ces-secure-install.enabled`  | Route tool/command installation through CES secure bundle pipeline instead of direct shell                                                          | Yes — falls back to standard install if CES is unavailable                                                                      |
| 4     | `feature_flags.ces-grant-audit.enabled`     | Gate CLI execution of grant listing, grant revocation, and audit inspection commands (commands are always registered but check the flag at runtime) | Yes — read-only inspection surfaces                                                                                             |
| 5     | `feature_flags.ces-managed-sidecar.enabled` | Use managed sidecar transport (Unix socket) instead of local child-process transport                                                                | **No** — requires the CES sidecar container to be present in the pod template. Only enable after the sidecar image is deployed. |

### Dark-launching the managed sidecar

To dark-launch CES in managed deployments without user impact:

1. **Deploy the CES container image** via the `credential_executor_image` field in `POST /v1/internal/assistant-image-releases/`. The warm-pool manager picks it up and includes it in pod templates. The CES container starts, binds its bootstrap socket and health port (8090), but does nothing until an assistant connects.

2. **Verify sidecar health** using kubelet probes: `/healthz` (liveness, returns `{"status": "ok"}`) and `/readyz` (readiness, always returns 200; includes `rpcConnected` field for observability).

3. **Enable `ces-tools`** first on a test cohort. The assistant spawns a local CES child process and registers tools. Verify tool registration, grant creation, and audit logging work end-to-end without affecting existing workflows.

4. **Enable `ces-managed-sidecar`** on the same cohort. The assistant switches from child-process transport to the bootstrap Unix socket. CES `/readyz` always returns 200 with `{"status": "ok", "rpcConnected": <boolean>}`; check the `rpcConnected` field to verify the assistant has connected.

5. **Progressive rollout**: Widen the cohort by enabling flags on more assistants. Monitor for grant failures, materializer errors, and egress proxy issues.

### Local deployment rollout

Local deployments do not require image changes. Enabling `ces-tools` causes the assistant to spawn CES as a child process automatically. The remaining flags can be enabled in any order.

### Guarantees by deployment mode

| Guarantee                                  | Local                                                                                                 | Managed                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process-boundary credential isolation      | Strong (separate child process)                                                                       | Strong (separate container)                                                                                                                      |
| Credential value never in assistant memory | Strong                                                                                                | Strong                                                                                                                                           |
| Grant persistence survives restarts        | Strong (filesystem-backed under `~/.vellum/protected/`)                                               | Strong (dedicated `/ces-data` volume)                                                                                                            |
| Network egress enforcement via proxy       | Moderate (cooperative via HTTP_PROXY/HTTPS_PROXY env vars; host networking is available — see Risk 7) | Moderate (cooperative via env vars; per-container Calico/NetworkPolicy egress restriction is a v2 design goal but not yet enforced — see Risk 7) |
| Secret scrubbing in HTTP responses         | Defense-in-depth only                                                                                 | Defense-in-depth only                                                                                                                            |
| `host_bash` restriction                    | Policy-only (trust rules can deny, but the tool exists)                                               | Policy-only (same; managed deployments should deny `host_bash` for untrusted agents)                                                             |

## Rollback

### Disabling CES entirely

Turn off all CES feature flags. The assistant stops registering CES tools and reverts to the pre-CES credential broker for all credential operations. No data migration is needed — CES grant and audit state is CES-private and does not affect the assistant's own tables.

Flag disable order:

> **Important — managed deployments**: In managed containers, the assistant image does not ship the `credential-executor` binary, so local CES transport is unavailable. Disabling `ces-managed-sidecar` while `ces-tools` is still enabled will break credentialed tool execution because the assistant cannot fall back to local discovery. Always disable `ces-tools` before `ces-managed-sidecar` in managed deployments.

**Local deployments** (reverse of enable order):

1. `ces-managed-sidecar` — assistant reverts to local child-process transport
2. `ces-grant-audit` — inspection surfaces disappear
3. `ces-secure-install` — tool installation reverts to direct shell
4. `ces-shell-lockdown` — shell lockdown is lifted
5. `ces-tools` — CES tools are unregistered from the agent loop

**Managed deployments** (`ces-tools` must be disabled before the sidecar):

1. `ces-grant-audit` — inspection surfaces disappear
2. `ces-secure-install` — tool installation reverts to direct shell
3. `ces-shell-lockdown` — shell lockdown is lifted
4. `ces-tools` — CES tools are unregistered; assistant reverts to the pre-CES credential broker
5. `ces-managed-sidecar` — sidecar transport is deactivated (safe now that no CES tools are registered)

### Removing the managed sidecar

If the CES sidecar container causes pod scheduling issues or resource pressure:

1. Disable `ces-tools` on all assistants first (prevents the assistant from attempting CES calls).
2. Disable `ces-managed-sidecar` on all assistants.
3. Remove the CES container and its volume mounts from the pod template in vembda.
4. CES grant/audit data on the `/ces-data` volume is orphaned and can be cleaned up at convenience.

The assistant reverts to the pre-CES credential broker once `ces-tools` is disabled.

### Partial rollback

Individual flags can be disabled independently:

- Disabling `ces-shell-lockdown` alone re-allows direct shell access to credentialed services while keeping CES tools available.
- Disabling `ces-grant-audit` alone removes inspection surfaces without affecting CES execution.
- Disabling `ces-secure-install` alone reverts tool installation to direct shell without affecting CES command execution.

## Residual Risks

Risks that are acknowledged and accepted for v1, documented here so they are explicit rather than implied.

### 1. `host_bash` is a weaker security tier

`host_bash` executes commands on the host machine with full access to the host environment. CES does not intercept or sandbox `host_bash` invocations. An untrusted agent with `host_bash` access can read credentials from environment variables, config files, or keychains.

**Mitigation**: Trust rules and permission policies should deny `host_bash` for untrusted agents in managed deployments. This is a policy enforcement, not a technical guarantee. The CES process-boundary isolation only protects operations routed through CES tools.

### 2. Response/output filtering is defense-in-depth, not primary protection

Secret scrubbing in HTTP response bodies and command stdout/stderr uses exact-match replacement of known credential values. This has inherent limitations:

- Only scrubs exact matches (no partial, encoded, or transformed variants)
- Short secrets (< 8 characters) are skipped to avoid false positives
- Base64-encoded, URL-encoded, or otherwise transformed secrets are not caught

**Mitigation**: The primary protection is the process-boundary isolation — the assistant never receives credential values in the first place. Response filtering is a supplementary layer for APIs that echo secrets back. Do not rely on scrubbing as the sole secret-leakage prevention.

### 3. Egress proxy enforcement is process-level, not network-level

The egress proxy relies on `HTTP_PROXY`/`HTTPS_PROXY` environment variables. A subprocess that ignores proxy env vars (e.g., a binary that uses its own HTTP stack or raw sockets) can bypass the proxy. This applies to both local and managed deployments — see Risk 7 for details on the managed case.

**Mitigation**: For local deployments, the process-level enforcement is accepted as a reasonable trade-off — the user running the assistant locally already has full host access. For managed deployments, per-container Calico network policies restricting CES egress to the proxy sidecar only are a design goal (see Risk 7 mitigation). Until those policies are in place, the denied-binary list and manifest validation reduce the surface for non-cooperating binaries.

### 4. No runtime sandboxing beyond process isolation

CES commands run in a separate process with a clean environment (isolated HOME, stripped env vars, proxy injection) but do not use container-level or VM-level sandboxing in local mode. A malicious command binary could escalate privileges or read host files.

**Mitigation**: Secure command bundles must be published and approved in the CES toolstore before execution. The manifest-driven validation (denied binaries, allowed argv patterns, denied subcommands/flags) restricts what can run. In managed deployments, per-container Calico network policies restricting CES egress are a design goal but not yet enforced (see Risk 7 and the guarantees table above). Current managed mitigation relies on the same denied-binary list and manifest validation as local deployments.

### 5. Secure command manifest is trusted after registration

Once a secure command manifest passes validation and is published to the toolstore, it is trusted for the lifetime of the bundle digest. There is no runtime re-validation of the bundle contents against the manifest (beyond re-checking the denied-binary list).

**Mitigation**: The toolstore uses SHA-256 digests for integrity verification. Manifest registration is a privileged operation gated by CES RPC. Future iterations may add periodic bundle re-verification.

### 6. v1 does not support credential rotation notification

When a credential is rotated (e.g., an API key is regenerated), existing CES grants referencing that credential continue to use the old value until the grant expires or is revoked. CES does not receive push notifications about credential rotation.

**Mitigation**: Grants have TTL-based expiry. Operators can force-revoke grants via the grant revocation RPC. Future iterations may integrate with credential-rotation webhooks to auto-revoke affected grants.

### 7. Cooperative isolation for both network egress and filesystem access

CES enforces isolation controls cooperatively rather than at the OS level:

- **Network egress**: CES injects `HTTP_PROXY`/`HTTPS_PROXY` environment variables into the subprocess environment. A binary that ignores proxy environment variables, implements its own HTTP stack, or opens raw sockets can bypass CES egress controls entirely. Risk #3 above documents this limitation for both local and managed deployments. In managed deployments specifically, current network policies allow public egress from all containers in the pod, so a non-cooperating binary in the CES container can reach the internet without going through the egress proxy.

- **Filesystem access**: CES commands run with `cwd` set to a CES-private scratch directory, but this is cooperative — commands can use absolute paths to read or write arbitrary locations on the host filesystem. There is no chroot, filesystem namespace, or bind-mount isolation restricting file access. A command that resolves `..` paths or uses absolute paths can escape the scratch directory to access any file readable/writable by the CES process user.

Both limitations stem from the same root cause: v1 relies on process-level conventions (env vars for network, cwd for filesystem) rather than OS-level enforcement primitives.

**Mitigation**: The denied-binary list and manifest validation restrict which binaries can run as secure commands, reducing the surface for non-cooperating binaries. In practice, the well-known CLI tools approved as secure command entrypoints (e.g., `gh`, `aws`) respect proxy environment variables. Bundles are content-addressed (SHA-256 digest) and immutable after registration, and user approval is required before any secure command executes — together these form a defense-in-depth chain that compensates for the cooperative enforcement model.

True kernel-level enforcement requires OS-level sandboxing — Linux network namespaces for mandatory proxy routing (iptables REDIRECT rules), Kubernetes NetworkPolicies or Calico egress policies restricting CES container traffic to the proxy sidecar only, and filesystem namespaces or chroot for path isolation. This is a v2 concern for **managed mode**, where CES runs in its own container with full namespace support. In **local mode**, kernel-level enforcement is impractical because CES runs as a user-space child process of the assistant — the user already has full host access, and iptables/network namespace manipulation requires root privileges that the assistant does not (and should not) have.

### 8. `credential_process` adapter shares cooperative egress limitation with main command

The `credential_process` auth adapter executes `sh -c <helperCommand>` with the raw credential piped to stdin. The helper now runs **after** the egress proxy session is started and receives the same proxy environment variables (`HTTP_PROXY`/`HTTPS_PROXY`) as the main command. For `no_network` mode, the helper receives dead-proxy env vars that block outbound connections.

This means the helper is subject to the same cooperative egress limitation as the main command (see Risk #7): a helper binary that ignores proxy environment variables, implements its own HTTP stack, or opens raw sockets can still bypass egress controls.

**Mitigation**: The `credential_process` helper command is specified in the secure command manifest, which is validated and approved at registration time. Only trusted helper commands should be registered. The helper's purpose is to transform credential format (e.g., producing AWS `credential_process` JSON output), not to make network calls. The denied-binary list prevents generic HTTP clients and interpreters from being used as helpers. The same future mitigations discussed in Risk #7 (per-container network policies, network namespace isolation) would also cover the helper process.

## Intentional v1 Out-of-Scope

The following capabilities are intentionally deferred beyond v1:

- **`local_static` handles in managed mode** — Technically feasible with v2 `store.key` (UID-independent), but managed mode currently uses `platform_oauth` exclusively as a policy choice (see Locked Decision #2). May be enabled in the future via shared `store.key` volume mount if there is a compelling use case.
- **Cloud KMS/Vault integration for secret storage** — v1 reads secrets from filesystem (`~/.vellum/protected/` locally, `/ces-data` in managed). Moving to a dedicated secrets manager is a future enhancement.
- **Multi-CES-instance support** — Each assistant pod runs exactly one CES sidecar. Horizontal scaling of CES within a pod is not supported.
- **Cross-pod credential sharing** — CES grants are scoped to a single pod. There is no grant federation across pods or assistant instances.
- **Browser automation through CES** — Browser form-fill with credential injection is deferred beyond initial rollout.
- **Credential rotation webhooks** — See residual risk 6 above.

## See Also

- [Security architecture](architecture/security.md) — existing credential broker and permission model
- [AGENTS.md](../../AGENTS.md) — tooling direction and CES exception
- [Tools AGENTS.md](../src/tools/AGENTS.md) — tooling direction and CES exception
- [Network traffic matrix](../../../vellum-assistant-platform/docs/network-traffic-matrix.md) — managed pod network policies
