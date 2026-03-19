# Integrations Architecture

OAuth, messaging adapters, script proxy, and conversation disk view architecture.

## Integrations — OAuth2 + Unified Messaging

The integration framework lets Vellum connect to third-party services via OAuth2. The architecture follows these principles:

- **Secrets never reach the LLM** — OAuth tokens are stored in the credential vault and accessed exclusively through the `TokenManager`, which provides tokens to tool executors via `withValidToken()`. The LLM never sees raw tokens.
- **PKCE or client_secret flows** — Desktop apps use PKCE by default (S256). Providers that require a client secret (e.g. Slack) pass it during the OAuth2 flow and store it in credential metadata for autonomous refresh.
- **Unified messaging layer** — All messaging platforms implement the `MessagingProvider` interface. Generic tools delegate to the provider, so adding a new platform is just implementing one adapter + an OAuth setup skill.
- **Provider registry** — Messaging providers register at daemon startup. The registry tracks which providers have stored credentials, enabling auto-selection when only one is connected.

### Unified Messaging Architecture

```mermaid
graph TB
    subgraph "Messaging Skill (bundled-skills/messaging/)"
        MSG_SKILL_MD["SKILL.md<br/>agent instructions"]
        MSG_TOOLS_JSON["TOOLS.json<br/>tool manifest"]
        AUTH_TEST["messaging_auth_test"]
        LIST["messaging_list_conversations"]
        READ["messaging_read"]
        SEARCH["messaging_search"]
        SEND["messaging_send (+ reply via thread_id)"]
        MARK_READ["messaging_mark_read"]
        STYLE["messaging_analyze_style"]
        DRAFT["messaging_draft"]
        SENDER_DIGEST["messaging_sender_digest"]
        ARCHIVE_BY_SENDER["messaging_archive_by_sender"]
        SHARED["shared.ts<br/>resolveProvider + getProviderConnection"]
    end

    subgraph "Gmail Skill (bundled-skills/gmail/)"
        GMAIL_SKILL_MD["SKILL.md<br/>agent instructions"]
        GMAIL_ARCHIVE["gmail_archive"]
        GMAIL_LABEL["gmail_label"]
        GMAIL_TRASH["gmail_trash"]
        GMAIL_UNSUB["gmail_unsubscribe"]
        GMAIL_DRAFT["gmail_draft"]
        GMAIL_SEND_DRAFT["gmail_send_draft"]
        GMAIL_ATTACHMENTS["gmail_attachments"]
        GMAIL_FORWARD["gmail_forward"]
        GMAIL_FOLLOW_UP["gmail_follow_up"]
        GMAIL_FILTERS["gmail_filters"]
        GMAIL_VACATION["gmail_vacation"]
        GMAIL_SENDER_DIGEST["gmail_sender_digest"]
        GMAIL_OUTREACH["gmail_outreach_scan"]
    end

    subgraph "Slack Skill (bundled-skills/slack/)"
        SLACK_SKILL_MD["SKILL.md<br/>agent instructions"]
        SLACK_SCAN["slack_scan_digest"]
        SLACK_DETAILS["slack_channel_details"]
        SLACK_CONFIGURE["slack_configure_channels"]
        SLACK_REACT["slack_add_reaction"]
        SLACK_DELETE["slack_delete_message"]
        SLACK_EDIT["slack_edit_message"]
        SLACK_LEAVE["slack_leave_channel"]
        SLACK_PERMS["slack_channel_permissions"]
    end

    subgraph "Sequences Skill (bundled-skills/sequences/)"
        SEQ_SKILL_MD["SKILL.md<br/>agent instructions"]
        SEQ_CREATE["sequence_create"]
        SEQ_LIST["sequence_list"]
        SEQ_GET["sequence_get"]
        SEQ_UPDATE["sequence_update"]
        SEQ_DELETE["sequence_delete"]
        SEQ_ENROLL["sequence_enroll"]
        SEQ_ENROLLMENT_LIST["sequence_enrollment_list"]
        SEQ_IMPORT["sequence_import"]
        SEQ_ANALYTICS["sequence_analytics"]
    end

    subgraph "Messaging Layer (messaging/)"
        PROVIDER_IF["MessagingProvider interface"]
        REGISTRY["Provider Registry"]
        TYPES["Platform-agnostic types<br/>Conversation, Message, SearchResult"]
        STYLE_ANALYZER["Style Analyzer"]
        DRAFT_STORE["Draft Store"]
    end

    subgraph "Provider Adapters"
        SLACK_ADAPTER["Slack Adapter<br/>messaging/providers/slack/"]
        GMAIL_ADAPTER["Gmail Adapter<br/>messaging/providers/gmail/"]
        TELEGRAM_ADAPTER["Telegram Adapter<br/>messaging/providers/telegram-bot/"]
    end

    subgraph "External APIs"
        SLACK_API["Slack Web API"]
        GMAIL_API["Gmail REST API"]
        TELEGRAM_API["Telegram Bot API"]
    end

    SHARED --> REGISTRY
    REGISTRY --> PROVIDER_IF
    SLACK_ADAPTER -.->|implements| PROVIDER_IF
    GMAIL_ADAPTER -.->|implements| PROVIDER_IF
    TELEGRAM_ADAPTER -.->|implements| PROVIDER_IF
    SLACK_ADAPTER --> SLACK_API
    GMAIL_ADAPTER --> GMAIL_API
    TELEGRAM_ADAPTER --> TELEGRAM_API
    AUTH_TEST --> SHARED
    LIST --> SHARED
    SEARCH --> SHARED
    SEND --> SHARED
    STYLE --> STYLE_ANALYZER
    GMAIL_ARCHIVE --> GMAIL_ADAPTER
    SLACK_REACT --> SLACK_ADAPTER
```

### Data Flow

```mermaid
sequenceDiagram
    participant UI as Settings UI (Swift)
    participant HTTP as HTTP Transport
    participant Handler as Daemon Handlers
    participant Registry as IntegrationRegistry
    participant OAuth as OAuth2 PKCE Flow
    participant Browser as System Browser
    participant Google as Google OAuth Server
    participant Store as SQLite OAuth Store
    participant Vault as Secure Keychain
    participant TokenMgr as TokenManager
    participant Tool as Gmail Tool Executor
    participant API as Gmail REST API

    Note over UI,API: Connection Flow
    UI->>HTTP: integration_connect {integrationId: "gmail"}
    HTTP->>Handler: dispatch
    Handler->>Registry: getIntegration("gmail")
    Registry-->>Handler: IntegrationDefinition
    Handler->>OAuth: startOAuth2Flow(config)
    OAuth->>OAuth: generate code_verifier + code_challenge (S256)
    OAuth->>OAuth: start Bun.serve on random port
    OAuth->>HTTP: open_url (Google consent URL)
    HTTP->>Browser: open URL
    Browser->>Google: user authorizes
    Google->>OAuth: callback with auth code
    OAuth->>Google: exchange code + code_verifier for tokens
    Google-->>OAuth: access + refresh tokens
    OAuth->>Store: storeOAuth2Tokens() → upsert oauth_app + oauth_connection rows
    Store->>Vault: setSecureKeyAsync("oauth_connection/{id}/access_token")
    Store->>Vault: setSecureKeyAsync("oauth_connection/{id}/refresh_token")
    Store->>Store: write expiresAt, grantedScopes to oauth_connections
    OAuth-->>Handler: success + account email
    Handler->>HTTP: integration_connect_result {success, accountInfo}
    HTTP->>UI: show connected state

    Note over UI,API: Tool Execution Flow
    Tool->>TokenMgr: withValidToken("gmail", callback)
    TokenMgr->>Store: getConnectionByProvider("integration:google")
    TokenMgr->>Vault: getSecureKeyAsync("oauth_connection/{conn.id}/access_token")
    TokenMgr->>Store: check oauth_connections.expires_at
    alt Token expired
        TokenMgr->>Store: resolveRefreshConfig() → tokenUrl, clientId from provider/app rows
        TokenMgr->>Google: refresh with refresh_token
        Google-->>TokenMgr: new access token
        TokenMgr->>Vault: setSecureKeyAsync("oauth_connection/{id}/access_token")
        TokenMgr->>Store: updateConnection(expiresAt)
    end
    TokenMgr->>Tool: callback(validToken)
    Tool->>API: Gmail REST API call with Bearer token
    API-->>Tool: response
    alt 401 Unauthorized
        Tool->>TokenMgr: retry (auto-refresh + re-execute)
    end
```

### Key Design Decisions

| Decision                                   | Rationale                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PKCE by default, optional client_secret    | Desktop apps prefer PKCE; some providers (Slack) require a secret, which is stored in the secure keychain (`oauth_app/{id}/client_secret`) for autonomous refresh                                                                                |
| Shared connect orchestrator                | All OAuth providers route through `orchestrateOAuthConnect()`, which resolves profiles, enforces scope policy, runs the flow, stores tokens, and verifies identity. Adding a provider is a declarative profile entry, not new orchestration code |
| Canonical credential naming                | All reads and writes use `client_id`/`client_secret` as canonical field names                                                                                                                                                                    |
| Gateway callback transport                 | OAuth callbacks are now routed through the gateway at `${ingress.publicBaseUrl}/webhooks/oauth/callback` instead of a loopback redirect URI. This enables OAuth flows to work in remote and tunneled deployments.                                |
| Unified `MessagingProvider` interface      | All platforms implement the same contract; generic tools work immediately for new providers                                                                                                                                                      |
| Provider auto-selection                    | If only one provider is connected, tools skip the `platform` parameter — seamless single-platform UX                                                                                                                                             |
| Token expiry in SQLite oauth-store         | `oauth_connections.expires_at` column tracks token expiry; `TokenManager` reads it for proactive refresh with 5min buffer. No separate metadata store needed                                                                                     |
| Confidence scores on medium-risk tools     | LLM self-reports confidence (0-1); enables future trust calibration without blocking execution                                                                                                                                                   |
| Platform-specific extension tools          | Operations unique to one platform (e.g. Gmail labels, Slack reactions) are separate tools, not forced into the generic interface                                                                                                                 |
| Identity verification before token storage | OAuth2 tokens are only persisted after a successful identity verification call, preventing storage of invalid or mismatched credentials                                                                                                          |

### Source Files

| File                                             | Role                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `assistant/src/security/oauth2.ts`               | OAuth2 flow: PKCE or client_secret, Bun.serve callback, token exchange                             |
| `assistant/src/security/token-manager.ts`        | `withValidToken()` — auto-refresh, 401 retry, expiry buffer                                        |
| `assistant/src/messaging/provider.ts`            | `MessagingProvider` interface                                                                      |
| `assistant/src/messaging/provider-types.ts`      | Platform-agnostic types (Conversation, Message, SearchResult)                                      |
| `assistant/src/messaging/registry.ts`            | Provider registry: register, lookup, list connected                                                |
| `assistant/src/messaging/style-analyzer.ts`      | Writing style extraction from message corpus                                                       |
| `assistant/src/messaging/draft-store.ts`         | Local draft storage (platform/id JSON files)                                                       |
| `assistant/src/messaging/providers/slack/`       | Slack adapter, client, types                                                                       |
| `assistant/src/messaging/providers/gmail/`       | Gmail adapter, client, types                                                                       |
| `assistant/src/config/bundled-skills/messaging/` | Core messaging skill (send, read, search, reply across platforms)                                  |
| `assistant/src/config/bundled-skills/gmail/`     | Gmail management skill (archive, label, triage, declutter)                                         |
| `assistant/src/config/bundled-skills/sequences/` | Email sequence management skill (drip campaigns, enrollment, analytics)                            |
| `assistant/src/watcher/providers/gmail.ts`       | Gmail watcher using History API                                                                    |
| `assistant/src/watcher/providers/github.ts`      | GitHub watcher for PRs, issues, review requests, and mentions                                      |
| `assistant/src/watcher/providers/linear.ts`      | Linear watcher for assigned issues, status changes, and @mentions                                  |
| `assistant/src/oauth/provider-behaviors.ts`      | Provider behavior registry: identity verifiers, setup metadata, injection templates                |
| `assistant/src/oauth/connect-orchestrator.ts`    | Shared OAuth connect orchestrator: profile resolution, scope policy, flow execution, token storage |
| `assistant/src/oauth/scope-policy.ts`            | Deterministic scope resolution and policy enforcement                                              |
| `assistant/src/oauth/connect-types.ts`           | Shared types: `OAuthProviderBehavior`, `OAuthScopePolicy`, `OAuthConnectResult`                    |
| `assistant/src/oauth/token-persistence.ts`       | Token storage helper: persists tokens, metadata, and runs post-connect hooks                       |
| `assistant/src/daemon/handlers/oauth-connect.ts` | Generic OAuth connect handler (`oauth_connect_start` / `oauth_connect_result`)                     |

---

## OAuth Extensibility — Provider Behaviors, Scope Policy, and Connect Orchestrator

The OAuth extensibility layer makes adding a new OAuth provider a declarative operation. Protocol fields (auth URLs, token URLs, scopes, scope policy) are stored in the `oauth_providers` database table, while behavioral fields (identity verifiers, setup metadata, injection templates) live in the **provider behavior registry**. The shared **connect orchestrator** handles the full flow from provider resolution through token storage.

### Provider Behavior Registry

`assistant/src/oauth/provider-behaviors.ts` contains the `PROVIDER_BEHAVIORS` map — a registry of behavioral aspects for well-known OAuth providers. Each behavior (`OAuthProviderBehavior`) declares:

| Field                | Purpose                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `identityVerifier`   | Async function that fetches human-readable account info (e.g. `@username`, email) after token exchange |
| `setup`              | Optional metadata for the generic OAuth setup skill (display name, dashboard URL, app type)            |
| `injectionTemplates` | Auto-applied credential injection rules for the script proxy                                           |

Protocol fields (`authUrl`, `tokenUrl`, `defaultScopes`, `scopePolicy`, `callbackTransport`) are stored in the `oauth_providers` database table rather than in code.

Registered providers: `integration:google`, `integration:slack`, `integration:notion`. Short aliases (e.g. `gmail`, `slack`) are resolved via `resolveService()`.

### Scope Policy Engine

`assistant/src/oauth/scope-policy.ts` exports `resolveScopes(profile, requestedScopes)`, which deterministically computes the final scope set:

1. No requested scopes → returns `defaultScopes`.
2. Requested scopes provided → starts with defaults, then validates each additional scope:
   - Rejected if in `forbiddenScopes`.
   - Rejected if `allowAdditionalScopes` is `false`.
   - Rejected if not in `allowedOptionalScopes`.
   - Accepted otherwise, added to the union.

Returns `{ ok: true, scopes }` or `{ ok: false, error, allowedScopes }`.

### Connect Orchestrator

`assistant/src/oauth/connect-orchestrator.ts` exports `orchestrateOAuthConnect(options)`, which runs the full OAuth2 flow:

1. **Resolve service** — alias expansion via `resolveService()`.
2. **Load behavior** — `getProviderBehavior()` from the registry; load protocol fields from the `oauth_providers` DB table.
3. **Compute scopes** — `resolveScopes()` with scope policy enforcement.
4. **Build OAuth config** — assemble protocol-level config from the DB provider row.
5. **Run flow** — interactive (opens browser, blocks until completion) or deferred (returns auth URL for the caller to deliver).
6. **Verify identity** — runs the profile's `identityVerifier` if defined.
7. **Store tokens** — `storeOAuth2Tokens()` persists access/refresh tokens, client credentials, and metadata.

Result is a discriminated union: `{ success, deferred, grantedScopes, accountInfo }` or `{ success: false, error }`.

### Generic Daemon HTTP API

`assistant/src/daemon/handlers/oauth-connect.ts` handles `oauth_connect_start` messages. The handler:

1. Resolves client credentials from the keychain using canonical names (`client_id`, `client_secret`).
2. Validates that required credentials exist (including `client_secret` when the provider requires it).
3. Delegates to `orchestrateOAuthConnect()`.
4. Sends `oauth_connect_result` back to the client.

This replaces provider-specific handlers — any provider in the registry can be connected through the same message pair.

### Adding a New OAuth Provider

1. **Register protocol fields** in the `oauth_providers` database table (via CLI or migration):
   - Set `authUrl`, `tokenUrl`, `defaultScopes`, `scopePolicy`, and `callbackTransport`.
2. **Optional: declare behavioral fields** in `PROVIDER_BEHAVIORS` (`oauth/provider-behaviors.ts`):
   - Add an `identityVerifier` — an async function that fetches the user's account info from the provider's API.
   - Add `setup` metadata — `displayName`, `dashboardUrl`, `appType` enable the generic OAuth setup skill to guide users through app creation.
   - Add `injectionTemplates` — for providers whose tokens should be auto-injected by the script proxy.
3. **No handler code needed** — the generic `oauth_connect_start` handler and the connect orchestrator handle the flow automatically.

### Key Source Files

| File                                             | Role                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `assistant/src/oauth/provider-behaviors.ts`      | Provider behavior registry and alias resolution                                  |
| `assistant/src/oauth/scope-policy.ts`            | Scope resolution and policy enforcement (pure, no I/O)                           |
| `assistant/src/oauth/connect-orchestrator.ts`    | Shared connect orchestrator (profile → scopes → flow → tokens)                   |
| `assistant/src/oauth/connect-types.ts`           | Shared types (`OAuthProviderBehavior`, `OAuthScopePolicy`, `OAuthConnectResult`) |
| `assistant/src/oauth/token-persistence.ts`       | Token storage: keychain writes, metadata upsert, post-connect hooks              |
| `assistant/src/daemon/handlers/oauth-connect.ts` | Generic `oauth_connect_start` / `oauth_connect_result` handler                   |

---

---

## Script Proxy — Proxied Bash Execution and Credential Injection

Scripts executed via the `bash` tool can optionally run through a per-session HTTP proxy. The proxy subsystem extends the existing credential storage and permission systems rather than introducing parallel mechanisms. The session manager uses `createProxyServer()` with a fully configured MITM handler, policy callback, and rewrite callback — so credential injection, policy enforcement, and approval prompting are all active at runtime. `host_bash` is explicitly unaffected: only the `bash` tool participates in proxied-mode checks.

### Proxied Bash Execution Path

When a bash command requires network access with credential injection, the sandbox backend switches from `network=none` to `network=bridge` and injects proxy environment variables so all HTTP/HTTPS traffic routes through the session proxy.

```mermaid
graph TB
    subgraph "Tool Invocation"
        BASH_CALL["bash tool call<br/>network_mode: 'proxied'"]
    end

    subgraph "Permission Check"
        EXECUTOR["ToolExecutor"]
        PERM["PermissionChecker<br/>classifyRisk → Medium<br/>(proxied bash)"]
        PROMPT["Prompt user<br/>persistentDecisionsAllowed: false<br/>(no trust rule saving for proxied bash)"]
    end

    subgraph "Sandbox"
        SANDBOX["NativeBackend.wrap()<br/>networkMode: 'proxied'"]
        ENV_INJECT["Inject env vars:<br/>HTTP_PROXY, HTTPS_PROXY,<br/>NO_PROXY, NODE_EXTRA_CA_CERTS"]
    end

    subgraph "Proxy Server (on host)"
        SERVER["ProxyServer<br/>127.0.0.1:ephemeral"]
        HTTP_FWD["HTTP Forwarder<br/>(plain HTTP proxy)"]
        CONNECT["CONNECT Handler"]
        ROUTER["Hybrid Router<br/>shouldIntercept()"]
    end

    BASH_CALL --> EXECUTOR
    EXECUTOR --> PERM
    PERM --> PROMPT
    PROMPT -->|"allowed"| SANDBOX
    SANDBOX --> ENV_INJECT
    ENV_INJECT -->|"HTTP"| HTTP_FWD
    ENV_INJECT -->|"HTTPS CONNECT"| CONNECT
    CONNECT --> ROUTER
```

### Hybrid MITM + Tunnel Routing

The proxy uses a two-mode routing strategy for HTTPS CONNECT requests. Only connections to hosts that match a credential injection template are MITM-intercepted; all other HTTPS traffic passes through a plain TCP tunnel with no TLS termination.

```mermaid
graph TB
    CONNECT["CONNECT host:port"] --> ROUTE["routeConnection()"]
    ROUTE --> CRED_CHECK{"Session has<br/>credential IDs?"}

    CRED_CHECK -->|"none"| TUNNEL_NC["TUNNEL<br/>reason: no_credentials"]

    CRED_CHECK -->|"yes"| HOST_MATCH{"Any template<br/>hostPattern matches?"}
    HOST_MATCH -->|"yes"| MITM["MITM<br/>reason: credential_injection"]
    HOST_MATCH -->|"no"| TUNNEL_NR["TUNNEL<br/>reason: no_rewrite"]

    subgraph "MITM Path"
        ISSUE_CERT["issueLeafCert(hostname)<br/>cached per-hostname"]
        TLS_TERM["Loopback TLS server<br/>on ephemeral port"]
        DECRYPT["Decrypt request"]
        REWRITE["RewriteCallback<br/>inject credential headers"]
        UPSTREAM["New TLS connection<br/>to real host"]
    end

    subgraph "Tunnel Path"
        TCP["Raw TCP tunnel<br/>bidirectional pipe<br/>no TLS termination"]
    end

    MITM --> ISSUE_CERT
    ISSUE_CERT --> TLS_TERM
    TLS_TERM --> DECRYPT
    DECRYPT --> REWRITE
    REWRITE --> UPSTREAM

    TUNNEL_NC --> TCP
    TUNNEL_NR --> TCP
```

**MITM path**: The proxy issues a leaf certificate signed by a local CA (`proxy-ca/ca.pem`), terminates TLS on a loopback ephemeral port, reads the decrypted HTTP request, calls the `RewriteCallback` to inject credential headers, and forwards the rewritten request over a fresh TLS connection to the real upstream. The local CA cert is injected into the container via `NODE_EXTRA_CA_CERTS`.

**Tunnel path**: For hosts that do not require credential injection, the proxy establishes a raw TCP tunnel (bidirectional pipe) and never sees the plaintext traffic. This avoids the overhead and security exposure of unnecessary TLS termination.

### Proxy Policy Engine and Approval Loop

The policy engine evaluates each outbound request against credential injection templates and determines whether credentials should be injected, whether the user should be prompted, or whether the request should pass through unauthenticated.

```mermaid
sequenceDiagram
    participant Script as Script (in container)
    participant Proxy as Proxy Server
    participant Policy as Policy Engine
    participant Approval as ProxyApprovalCallback
    participant Prompter as PermissionPrompter
    participant Trust as Trust Store
    participant User as User

    Script->>Proxy: outbound request to api.example.com
    Proxy->>Policy: evaluateRequestWithApproval(hostname, port, path, ...)

    alt Credential template matches host
        Policy-->>Proxy: matched (credentialId, template)
        Proxy->>Proxy: inject credential headers
        Proxy->>Script: proxied response
    else Known host pattern but no bound credential
        Policy-->>Proxy: ask_missing_credential
        Proxy->>Approval: request approval
        Approval->>Trust: check existing rule (proxy:hostname)
        alt Rule exists
            Trust-->>Approval: allow / deny
        else No rule
            Approval->>Prompter: prompt user
            Prompter->>User: confirmation dialog
            User-->>Prompter: decision
            Prompter-->>Approval: allow / deny / always_allow / always_deny
            Note over Approval: Save trust rule if always_*
        end
        Approval-->>Proxy: approved (true) / denied (false)
    else Unknown host, no credentials
        Policy-->>Proxy: ask_unauthenticated
        Proxy->>Approval: request approval
        Note over Approval: Same trust store + prompt flow
        Approval-->>Proxy: approved / denied
    end
```

**Policy decisions** are deterministic and structured:

| Decision                 | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `matched`                | Exactly one credential template matches the host — inject it               |
| `ambiguous`              | Multiple credential templates match — caller must disambiguate             |
| `missing`                | Credentials exist but none match this host — no rewrite                    |
| `unauthenticated`        | No credentials configured for the session                                  |
| `ask_missing_credential` | A known template pattern matches but no credential is bound to the session |
| `ask_unauthenticated`    | Completely unknown host — prompt for unauthenticated access                |

**Trust rule persistence**: The `createProxyApprovalCallback` in `conversation-tool-setup.ts` is wired into the session startup path and routes policy "ask" decisions through the existing `PermissionPrompter` UI. Trust rules use the `network_request` tool name (not `proxy:*`) with URL-based scope patterns (e.g., `https://api.example.com/*`), aligning with the `buildCommandCandidates()` allowlist generation in `checker.ts`.

**Proxied bash permission restriction**: The `ToolExecutor` sets `persistentDecisionsAllowed = false` when the bash tool is invoked with `network_mode: 'proxied'`. This prevents users from saving permanent trust rules for proxied bash commands, since the proxy session's credential scope can change between invocations.

### Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Starting : createSession(conversationId, credentialIds)
    Starting --> Active : startSession() → ephemeral port assigned
    Active --> Active : resetIdleTimer() on getSessionEnv()
    Active --> Stopping : stopSession() or idle timeout (5min)
    Stopping --> Stopped : server closed, timer cleared
```

Each proxy session is bound to a conversation and tracks authorized credential IDs. The `SessionManager` enforces a per-conversation limit (default 3 concurrent sessions). Sessions auto-stop after 5 minutes of inactivity. `stopAllSessions()` is called on daemon shutdown.

### Local CA and Certificate Management

The proxy generates and manages a local Certificate Authority for MITM interception:

| Component  | Location                                   | Purpose                                                  |
| ---------- | ------------------------------------------ | -------------------------------------------------------- |
| CA cert    | `{dataDir}/proxy-ca/ca.pem`                | Self-signed root cert (valid 10 years, permissions 0644) |
| CA key     | `{dataDir}/proxy-ca/ca-key.pem`            | CA private key (permissions 0600)                        |
| Leaf certs | `{dataDir}/proxy-ca/issued/{hostname}.pem` | Per-hostname certs (cached, verified against current CA) |

`ensureLocalCA()` is idempotent — it only generates the CA if the files do not already exist. Leaf certificates are cached and revalidated via `X509Certificate.checkIssued()` to detect stale certs from a previous CA.

### Log Sanitization

All proxy logging passes through sanitization helpers (`logging.ts`) that redact credential values before they reach logs or lifecycle events:

- `sanitizeHeaders()` — replaces values of sensitive header keys (e.g. `Authorization`) with `[REDACTED]`
- `sanitizeUrl()` — redacts query parameter values for sensitive param names (e.g. `api_key`)
- `createSafeLogEntry()` — combines both into a log-safe request snapshot

### Security Invariants

1. **Credential values never reach the LLM** — The proxy injects credentials at the network layer; the model only sees tool results, never the injected headers or query parameters.
2. **Minimal MITM surface** — Only hosts matching a credential injection template are MITM-intercepted. All other HTTPS traffic passes through an opaque TCP tunnel.
3. **CA key isolation** — The CA private key has 0600 permissions and never leaves the host filesystem. Container processes only receive the CA cert via `NODE_EXTRA_CA_CERTS`.
4. **No persistent trust rules for proxied bash** — `persistentDecisionsAllowed: false` prevents saving trust rules that could auto-allow proxied commands across sessions with different credential scopes.
5. **Auditable routing** — Every CONNECT routing decision carries a deterministic `RouteReason` code (`mitm:credential_injection`, `tunnel:no_rewrite`, `tunnel:no_credentials`) for audit and testing.

### Credential Proxy Injection

The proxy subsystem intercepts outbound HTTPS requests and injects stored credentials via header injection. Key behaviors:

- **Wildcard host patterns** (`*.example.com`) match both subdomains and the bare apex domain (`example.com`)
- **Specificity selection**: When one credential has both exact and wildcard templates for the same host, the most specific match wins (exact > wildcard)
- **Cross-credential ambiguity**: When multiple credentials match the same host, injection is blocked (fail-closed)
- **Credential references**: The shell tool accepts both UUIDs and `service/field` format (e.g., `fal/api_key`); unknown references fail fast before command execution
- **Diagnostic logging**: Policy and rewrite decisions are logged with structured traces that never include secret values

### Key Source Files

| File                                                          | Role                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `assistant/src/tools/network/script-proxy/server.ts`          | Proxy server factory — HTTP forwarding, CONNECT handling, MITM dispatch                                                 |
| `assistant/src/tools/network/script-proxy/policy.ts`          | Policy engine — evaluates requests against credential templates                                                         |
| `assistant/src/tools/network/script-proxy/mitm-handler.ts`    | MITM TLS interception — loopback TLS server, request rewrite, upstream forwarding                                       |
| `assistant/src/tools/network/script-proxy/connect-tunnel.ts`  | Plain CONNECT tunnel — raw TCP bidirectional pipe                                                                       |
| `assistant/src/tools/network/script-proxy/http-forwarder.ts`  | HTTP proxy forwarder — absolute-URL form forwarding with policy callback                                                |
| `assistant/src/tools/network/script-proxy/session-manager.ts` | Session lifecycle — create, start, stop, idle timeout, env var generation                                               |
| `assistant/src/tools/network/script-proxy/certs.ts`           | Local CA management — ensureLocalCA, issueLeafCert, getCAPath                                                           |
| `assistant/src/tools/network/script-proxy/logging.ts`         | Log sanitization (header/URL redaction) and safe decision trace builders for policy and credential resolution           |
| `assistant/src/tools/network/script-proxy/types.ts`           | Type definitions — session, policy decisions, approval callback                                                         |
| `assistant/src/tools/executor.ts`                             | `persistentDecisionsAllowed` gate — disables trust rule saving for proxied bash                                         |
| `assistant/src/daemon/conversation-tool-setup.ts`             | `createProxyApprovalCallback` — wired into session startup, uses `network_request` tool name with URL-based trust rules |
| `assistant/src/permissions/checker.ts`                        | `network_request` trust rule matching and risk classification (Medium)                                                  |

### Runtime Wiring Summary

The proxy subsystem is fully wired, including credential injection. The session manager's `startSession()` calls `createProxyServer()` with:

- **MITM handler config**: `mitmHandler` is configured with the local CA path and a `rewriteCallback` that performs per-credential specificity-based template selection — for each credential it picks the most specific matching header template (exact > wildcard), blocks on same-credential equal-specificity ties or cross-credential ambiguity, and for the winning `header`-type template resolves the secret from secure storage and sets the outbound header. Wildcard patterns (`*.fal.run`) match the bare apex domain (`fal.run`) via apex-inclusive matching.
- **Policy callback**: `evaluateRequestWithApproval()` is called via the `policyCallback`; for `'matched'` decisions it injects credential headers (reading the secret value at injection time), while `'ambiguous'` decisions are blocked and `'ask_*'` decisions route through the approval callback
- **Approval callback**: `createProxyApprovalCallback()` from `conversation-tool-setup.ts` routes approval prompts through the `PermissionPrompter`, using the `network_request` tool name with URL-based trust rules
- **networkMode plumbing**: `shell.ts` passes `{ networkMode }` to `wrapCommand()`, which forwards it to the native backend
- **Session lifecycle**: `createSession` / `startSession` / `stopSession` with idle timeout and per-conversation limits

---

## Conversation Disk View — Filesystem-Based Conversation Access

The conversation disk view projects conversation metadata, messages, and attachments to a browsable filesystem layout under `~/.vellum/workspace/conversations/`. This enables the assistant to search, read, and manipulate conversation data (including media attachments) using standard file tools (`read_file`, `glob`, `grep`) rather than dedicated asset search tools.

### Directory Layout

Each conversation is projected to a directory named `{isoDate}_{id}`:

```
~/.vellum/workspace/conversations/
  2025-01-15T10-30-00.000Z_abc123/
    meta.json             # Conversation metadata (id, title, type, channel, timestamps)
    messages.jsonl        # Flattened message log (one JSON object per line)
    attachments/          # Decoded attachment files (original filenames, collision-safe)
      photo.png
      document.pdf
```

### Write-Through Sync

The disk view is updated at the daemon level, not automatically by the DB CRUD layer. Conversation creation, metadata updates, and deletion are synced from `conversation-crud.ts`, but message sync (`syncMessageToDisk`) is only called from daemon-level code paths (e.g. `conversation-messaging.ts`) — not from the CRUD `addMessage()` function. This means `messages.jsonl` reflects messages processed through the daemon's messaging pipeline, not every message write. All disk writes are best-effort; failures are logged but never thrown, so the disk view cannot break DB operations.

> **Privacy note:** Conversation disk-view files live under `~/.vellum/workspace/conversations/` and are **excluded** from diagnostic log exports ("Send logs to Vellum") via the `WORKSPACE_SKIP_DIRS` filter in `log-export-routes.ts`. However, the SQLite database (`assistant.db`) is included in exports as a SQL dump, and it contains conversation messages and attachment data in its tables. The disk-view exclusion prevents the raw conversation files and decoded attachments from being exported, but conversation content stored in the database may still be present in the export.

```mermaid
sequenceDiagram
    participant CRUD as conversation-crud.ts
    participant Daemon as conversation-messaging.ts
    participant DiskView as conversation-disk-view.ts
    participant FS as Filesystem

    Note over CRUD,FS: Conversation creation (CRUD layer)
    CRUD->>CRUD: INSERT conversation row
    CRUD->>DiskView: initConversationDir(conv)
    DiskView->>FS: mkdir + write meta.json

    Note over Daemon,FS: Message insertion (daemon layer)
    Daemon->>CRUD: addMessage(convId, role, content)
    CRUD->>CRUD: INSERT message row
    Daemon->>DiskView: syncMessageToDisk(convId, msgId, createdAtMs)
    DiskView->>DiskView: flattenContentBlocks(content)
    DiskView->>FS: append JSONL record to messages.jsonl
    DiskView->>FS: write attachment files to attachments/

    Note over CRUD,FS: Conversation update (CRUD layer)
    CRUD->>CRUD: UPDATE conversation row
    CRUD->>DiskView: updateMetaFile(conv)
    DiskView->>FS: rewrite meta.json

    Note over CRUD,FS: Conversation deletion (CRUD layer)
    CRUD->>CRUD: DELETE conversation row
    CRUD->>DiskView: removeConversationDir(id, createdAtMs)
    DiskView->>FS: rm -rf conversation directory
```

### Content Flattening

Message content (stored as JSON `ContentBlock[]` in the DB) is flattened for the JSONL log:

- **Text blocks** are concatenated into a single `content` string.
- **Tool use blocks** are extracted into a `toolCalls` array (`{ name, input }`).
- **Tool result blocks** are extracted into a `toolResults` array.
- **Image/file blocks** are skipped — they are represented via the `attachments/` subdirectory instead.

### Attachment Projection

When a message with attachments is synced, each attachment's binary content is decoded from the DB and written to the `attachments/` subdirectory using the original filename. Filename collisions are resolved by appending a numeric suffix (e.g., `photo-2.png`, `photo-3.png`). The resolved filenames are recorded in the JSONL record's `attachments` array.

### Backfill Migration

Existing conversations created before the disk view was introduced are backfilled by workspace migration `009-backfill-conversation-disk-view`, which replays all conversations and their messages through the disk-view sync functions.

### Key Source Files

| File                                                                        | Role                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `assistant/src/memory/conversation-disk-view.ts`                            | Disk view module — init, update, sync, remove, content flattening                     |
| `assistant/src/memory/conversation-crud.ts`                                 | DB CRUD layer — calls init, update, and remove disk-view functions (not message sync) |
| `assistant/src/daemon/conversation-messaging.ts`                            | Daemon messaging pipeline — calls `syncMessageToDisk` after message insertion         |
| `assistant/src/workspace/migrations/009-backfill-conversation-disk-view.ts` | Backfill migration for pre-existing conversations                                     |

---
