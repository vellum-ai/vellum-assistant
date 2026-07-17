# Gateway — Agent Instructions

## Public API / Webhook Ingress

All inbound HTTP endpoints — APIs, webhooks, OAuth callbacks, or any route that receives requests from the internet — **MUST** be routed through the **gateway** (`gateway/`). Never add ingresses, routes, or listeners directly to the daemon runtime (`assistant/`).

Concretely:

- Define new routes in the gateway and have the gateway forward requests to the assistant over the internal HTTP transport.
- The gateway's public URL is controlled by the **public ingress URL** setting. All externally-facing URLs you generate or advertise (callback URLs, webhook registration URLs, etc.) must be derived from this setting — never hardcode a hostname or port.
- The daemon should remain unreachable from the public internet. It only receives traffic from the gateway over the internal network.
- Webhook handlers must read request bodies via `readLimitedBody()` / `readLimitedBodyBytes()` (`gateway/src/http/read-limited-body.ts`), which enforce `maxWebhookPayloadBytes` on the actual streamed bytes. Never call `req.text()` / `req.json()` / `req.formData()` directly on unauthenticated ingress — the Content-Length header is attacker-controlled and absent on chunked requests, so a header-only guard can be bypassed up to the server-wide `maxRequestBodySize`.

Why: the gateway is the single point of ingress, handling TLS termination, auth, rate limiting, and routing. Exposing the daemon directly bypasses these protections and breaks the deployment model.

### Gateway-Only API Consumption

All assistant API requests from clients, CLI, skills, and user-facing tooling **MUST** target gateway URLs. Never construct URLs using the daemon runtime port (`7821`) or `RUNTIME_HTTP_PORT` for external API consumption.

**Exception boundary:** The gateway service itself may call the runtime internally. Tests may use direct runtime URLs for isolated unit/integration scenarios. Intentional local daemon-control paths (e.g. health probes) are exempt; the authoritative allowlist lives in `assistant/src/__tests__/gateway-only-guard.test.ts`.

**Migration rule:** If a needed endpoint is not available at the gateway, add a gateway route/proxy first, then consume it. Do not work around a missing gateway endpoint by hitting the runtime directly.

**Ban on hardcoded runtime hosts/ports:** Do not embed `localhost:7821`, `127.0.0.1:7821`, or runtime-port-derived URLs in docs, skills, or user-facing guidance. Always reference gateway URLs instead. A CI guard test (`gateway-only-guard.test.ts`) enforces this — any new direct runtime URL reference in production code or skills will fail CI.

**SKILL.md retrieval contract:** For config/status retrieval in bundled skills, use `bash` + canonical CLI surfaces. Start with `assistant config get` for generic config keys and secure credential surfaces (`assistant credentials`, `assistant keys`) for secrets. Do not use direct gateway `curl` for read-only retrieval paths. Do not use credential store lookup commands (`security find-generic-password`, `secret-tool`) in SKILL.md. `host_bash` is not allowed for Vellum CLI retrieval commands unless a documented exception is intentionally allowlisted.

**SKILL.md proxied outbound pattern:** For outbound third-party API calls from skills that require stored credentials, default to `bash` with `network_mode: "proxied"` and `credential_ids` instead of manual token/credential store plumbing. This keeps credentials out of chat and enforces credential policies consistently.

**SKILL.md gateway URL pattern:** For gateway control-plane writes/actions that are not exposed through a CLI read command, use `$INTERNAL_GATEWAY_BASE_URL` (injected by `bash` and `host_bash`). Do not hardcode `localhost`/ports in skill examples, and do not instruct users/agents to manually export the variable from Settings. For public ingress URLs (e.g. OAuth redirect URIs, webhook registration), use `assistant config get ingress.publicBaseUrl` or load the `public-ingress` skill — do not inject public URLs as environment variables.

### Control-Plane Route Shapes — Clients Emit Scoped, Boundaries Strip to Flat

Clients always **emit** assistant-scoped URLs (`/v1/assistants/{id}/...`) — multi-tenant cloud routing needs the id. A single-assistant boundary strips the prefix before the gateway routes the request:

- **Cloud/managed:** the platform's Django `RuntimeProxyView` strips `/v1/assistants/{id}/` and forwards the flat path to the gateway.
- **Self-hosted (macOS Electron / local / remote gateway):** `rewriteForSelfHostedIngress` (`clients/web/src/lib/api-interceptors.ts`) flattens contact-family paths (`contacts`, `contact-channels`) to the same flat shape; every other segment is forwarded scoped, verbatim.

Route-registration consequences (`gateway/src/index.ts`):

- **Contacts** (`/v1/contacts...`, `/v1/contact-channels...`) are served on **flat routes only** — both boundaries deliver flat, so no assistant-scoped contact mirrors exist. The self-hosted flattening covers the **entire** `contacts`/`contact-channels` segment family, not just the CRUD writes: invites requests land on the gateway's flat edge-scoped invite routes (the same gateway invite engine the daemon relays to), and daemon-only subpaths (`contacts/search`, `contacts/prompt`) match no flat registration and fall through the runtime-proxy catch-all to the daemon verbatim.
- **Other control-plane families** (channel-admission-policy, channel-permission-overrides, trust-rules, backups) register **flat + assistant-scoped variants**: the self-hosted rewrite forwards their paths verbatim, so a scoped mirror must catch that traffic. These stores are gateway-global — the scoped variant matches and discards the id.
- **Invariant: never remove a flat gateway control-plane route.** Cloud's prefix strip means the flat family is the load-bearing production path even when repo-local clients appear to emit only scoped URLs. The flat channel-admission-policy routes were removed once on that mistaken theory (`2fb435314f`) and had to be restored before #35150 merged (`53fcfa7cc2` re-added the schema entries the removal took out).

### Trust Management in Docker Mode

In Docker mode, the gateway is the sole owner of trust rule storage. Trust files (`trust.json`, `actor-token-signing-key`) live on the gateway security volume (`/gateway-security`), configured via `GATEWAY_SECURITY_DIR`. No other container has access to this volume.

The assistant reads and writes trust rules via the gateway's HTTP trust API instead of accessing the filesystem directly. This ensures the security boundary is enforced at the container level — even if the assistant container is compromised, it cannot tamper with trust rules without going through the gateway's API.

### Backup Encryption Key

The backup encryption key (`backup.key`) lives in `GATEWAY_SECURITY_DIR` and is never exposed to the assistant daemon or workspace. The gateway owns all backup encryption/decryption — the assistant produces plaintext vbundles via `/v1/migrations/export`, and the gateway encrypts them for offsite storage. The assistant cannot read the key via `file_read` or any other tool. This is a security boundary: even if the assistant is prompt-injected, backup encryption remains intact.

### Credential Access in Docker Mode

In Docker mode, the gateway accesses stored credentials via the CES HTTP API (`CES_CREDENTIAL_URL`), authenticated with `CES_SERVICE_TOKEN`. The gateway does not have direct filesystem access to credential encryption keys (`keys.enc`, `store.key`), which reside on the CES security volume.

### Guardian Init Auth Model (`/v1/guardian/init`)

`/v1/guardian/init` mints a long-lived `actor_client_v1` JWT for a freshly hatched assistant. It has three deployment modes with **different** authentication mechanisms — do not collapse them into one fail-closed check.

1. **Platform-managed (`IS_PLATFORM=true`):** the gateway pod sits behind vembda's `/gateway-query` proxy, which authenticates the caller **before** forwarding. The pod is not directly reachable from the public internet. `GUARDIAN_BOOTSTRAP_SECRET` is **intentionally not provisioned** in any managed deployment surface (Helm chart, vembda `k8s_resources.py`, StatefulSet env). The bootstrap-secret mechanism is a laptop / Docker hatch artifact only.
2. **Docker / laptop hatch (`GUARDIAN_BOOTSTRAP_SECRET` set):** the CLI's `hatch.ts` mints a per-instance secret and forwards it into the gateway + assistant containers. The handler requires a matching `x-bootstrap-secret` header.
3. **Bare-metal self-hosted (no `IS_PLATFORM`, no secret):** the lockfile + loopback guard is the sole defense. Long-term direction is to retire `GUARDIAN_BOOTSTRAP_SECRET` entirely and replace it with an explicit pairing mechanism for self-hosted environments.

**For scanners / Codex:** managed mode reaching this handler without a bootstrap secret is the **expected** production state, not an auth bypass. Vembda authenticates upstream. Adding a fail-closed guard on `IS_PLATFORM=true && !GUARDIAN_BOOTSTRAP_SECRET` would brick every platform deployment. Do not flag this as a vulnerability.

### Channel Identity Vocabulary

Gateway inbound events use a channel-discriminated union model (`GatewayInboundEvent`) with explicit identity fields:

- **`conversationExternalId`**: Delivery/conversation address (e.g., Telegram chat ID, phone number). Used for conversation binding and message routing. **Not** used for trust classification.
- **`actorExternalId`**: Sender identity (e.g., Telegram user ID, WhatsApp phone number). Used for trust classification, guardian binding, and ACL enforcement. **Required** for all public channel ingress.
- **"conversation"** is canonical vocabulary for delivery addresses. "thread" is reserved for provider-specific fields (Slack `thread_ts`, email thread IDs).
- **"actor"** is canonical vocabulary for sender identity.

Trust/guardian decisions must be keyed on `actorExternalId` only — never fall back to `conversationExternalId` for actor identity.

Physical DB column names (`externalUserId`, `externalChatId`) are unchanged; the rename is at the API/type layer only.

## Channel Trust Classification & Admission Policy

The gateway owns per-channel `AdmissionPolicy` storage (`gateway/src/db/admission-policy-store.ts`, HTTP in `gateway/src/http/routes/channel-admission-policy.ts`) and attaches the floor to every forwarded inbound via `sourceMetadata.admissionPolicy`. The runtime (`assistant/src/runtime/routes/inbound-stages/admission-policy.ts`) emits `admitted: true | false` based on `TRUST_CLASS_RANK[trustClass] >= ADMISSION_FLOOR[policy]`.

A default row per enforced channel is **seeded at startup** (`seedAdmissionPolicyDefaults` in `gateway/src/db/seed-admission-policy.ts`) — `trusted_contacts` for every channel except `vellum` (`guardian_only`). Per-channel defaults live only in that seed; the store/cache fall back to `ADMISSION_POLICY_DEFAULT` (`trusted_contacts`) only if a row is somehow absent.

**5 policies, ranked floors** (seed default `trusted_contacts`):

| Policy             | Floor | Notes                                                                                                                         |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `no_one`           | 5     | Hard-deny at gateway _before_ forwarding (kill switch in `handle-inbound.ts`). Includes the guardian — this channel is _OFF_. |
| `guardian_only`    | 4     | Seeded default for `vellum`.                                                                                                  |
| `trusted_contacts` | 3     | Seeded default for all other channels; also the read-path safety fallback.                                                    |
| `any_contact`      | 2     | May surface Slack DM / email upgrade challenge on deny.                                                                       |
| `strangers`        | 1     | May surface upgrade challenge.                                                                                                |

**Exempt channels** (no policy ever applies — gateway **AND** runtime both short-circuit):

- `platform` — internal platform control plane.
- `a2a` — assistant-to-assistant peer traffic (out of human-trust model).

`phone` is now an enforced channel (voice ingress reads the policy): it seeds the universal default `trusted_contacts` and accepts PUT like other enforced channels.

For exempt ids, `PUT /v1/assistants/:id/channel-admission-policy/:channelType` returns **403**, the GET list omits them, and the runtime short-circuits `admitted: true` in `admission-policy.ts` (defense in depth). Codex finding from #35006 review: exemption checks must live in _both_ the gateway route handler AND the runtime stage — single-side enforcement creates a misuse wedge.

**Hidden channels** (`ADMISSION_POLICY_HIDDEN_CHANNELS` = `vellum`, `whatsapp`) — managed automatically, **not** user-configurable, but (unlike exempt channels) **still enforced at runtime**:

- The GET list omits them, and `PUT`/`DELETE` return **403** (`isAdmissionPolicyHiddenChannel`).
- They are **not** exempt — the runtime still evaluates rank-vs-floor, so a real inbound channel like `whatsapp` keeps its admission floor.
- Their floor is pinned to the seed default; `seedAdmissionPolicyDefaults` **overwrites** any drifted/legacy row at startup (e.g. a stale `whatsapp = no_one`), so a stranded floor can't silently block a channel the user can no longer see or reset. The guardian is always max-rank on `vellum`, so its `guardian_only` seed default never locks them out — there is **no** `no_one` picker or 422 kill-switch path for hidden channels.

Both the flat (`/v1/channel-admission-policy/...`) and assistant-scoped (`/v1/assistants/:id/channel-admission-policy/...`) route variants are registered. The flat routes carry all cloud traffic — the platform strips the scoped prefix before forwarding — and must never be removed (see "Control-Plane Route Shapes" above). Admission policy is gateway-global, so the scoped variant matches and discards the id.

**Split enforcement** (locked decision):

- **Gateway kill switch** — `handle-inbound.ts` enforces the `no_one` floor before forwarding. Zero contact-table lookups, zero daemon I/O, true kill.
- **Runtime floor** — every other policy flows through the gateway unchanged; the runtime evaluates rank-vs-floor inside `admission-policy.ts`. This keeps the canonical gateway classifier (`gateway/src/risk/trust-verdict-resolver.ts`) as the single source of `TrustClass` truth (no fork): the runtime consumes the stamped verdict; the daemon's `actor-trust-resolver.ts` is only a residual sync guardian-or-unknown view for the vellum reset-drift path.
- **Gateway vs runtime reciprocity** — the gateway section in `gateway/CLAUDE.md` records _which channels the gateway enforces_; the assistant section records _how the runtime classifies_. Either side getting out of sync is a bug, not an over-defended boundary.

**Adding a new policy**: extend the `AdmissionPolicy` union in `packages/gateway-client/src/admission-policy-contract.ts`, add its floor in `ADMISSION_FLOOR`, update the openapi schema, and update `gateway/src/__tests__/channel-admission-policy-routes.test.ts` + `assistant/src/runtime/routes/inbound-stages/admission-policy.test.ts`. Do not add a 6th floor without also bumping the `TRUST_CLASS_RANK` ceiling to match.

**Adding a new exempt channel**: update `ADMISSION_POLICY_EXEMPT_CHANNELS` in `packages/gateway-client/src/admission-policy-contract.ts` AND `EXEMPT_CHANNEL_TYPES` in `gateway/src/db/admission-policy-store.ts`. The gateway route (403), GET-list omission, runtime short-circuit, and seed-skip all read from these — symmetric enforcement is required so a stray runtime call (test harness, internal IPC) can't bypass the floor.

**Hiding a channel from the UI (still enforced)**: add it to `ADMISSION_POLICY_HIDDEN_CHANNELS` in `packages/gateway-client/src/admission-policy-contract.ts` (and the web mirror `HIDDEN_CHANNELS` in `clients/web/src/lib/channel-admission-policy/types.ts`). The GET-list omission, `PUT`/`DELETE` 403, and seed re-pin all read from this set. Use this — **not** the exempt set — for a channel that must keep enforcing a floor but should not be user-configurable, so its admission check is never short-circuited.

### Channel Permission Matrix (cells: cascade key × contact-type → RiskThreshold)

The gateway owns channel-permission matrix storage (`gateway/src/db/channel-permission-store.ts`, table `channel_permission_overrides`, IPC in `gateway/src/ipc/channel-permission-handlers.ts`). Each cell maps a cascade selector × contact-type (trust class) to a `RiskThreshold` (`none | low | medium | high`; the Strict/Conservative/Relaxed/Full-access presets are the web presentation layer over these values).

- **Cascade, least → most specific:** `workspace` → `adapter` → `channel_type` (`dm | private | public`) → `channel` (external channel ID). `ChannelPermissionStore.resolve()` walks most-specific-first and returns the first cell set for the contact-type.
- **Vocabulary contract:** `packages/gateway-client/src/channel-permission-contract.ts` (selectors, thresholds, scopes, resolve request). The contact-type axis is the canonical `TrustClass` — granularity intentionally stops there; do not add per-individual-contact cells.
- **IPC surface:** `list_channel_permission_overrides`, `set_channel_permission_override`, `delete_channel_permission_override`, `resolve_channel_permission_threshold`. Writes validate the adapter against the gateway channel registry.
- **HTTP surface (configuration clients):** `GET`/`PUT /v1/channel-permission-overrides` + `POST /v1/channel-permission-overrides/delete` + `POST /v1/channel-permission-overrides/resolve` (`gateway/src/http/routes/channel-permission-overrides.ts`), published in the gateway OpenAPI spec for the web SDK. Mirrors the IPC list/set/delete/resolve with the same contract schemas and adapter validation. Resolve over HTTP is read-only (`settings.read`) and exists so configuration clients can display the effective fall-through without re-implementing the cascade walk client-side (which drifts — the runtime resolves Slack rooms with no conversation type, so a client-side walk would apply `channel_type` cells the evaluator never matches); the runtime evaluator keeps using the IPC resolve. Flat + assistant-scoped variants, `settings.read`/`settings.write` scopes — same shape as channel-admission-policy.
- **Migration provenance:** `m0012-migrate-slack-channel-permissions` lifts Slack-skill `channelPermissions` profiles with `trustLevel: "restricted"` into channel-scoped Strict cells (non-guardian contact-types). Per-tool fields (`blockedTools` / `allowedToolCategories`) have no matrix representation — they stay in the Slack skill config, enforced by the legacy deterministic channel gate in `assistant/src/tools/tool-approval-handler.ts`.
- **Runtime consumption (per-tool-call evaluation):** the assistant's permission checker (`assistant/src/permissions/checker.ts`) builds a resolve query from the turn's `PolicyContext` (adapter = source channel, conversation type, external channel ID, contact-type = trust class) and threads it into the threshold cascade in `assistant/src/permissions/gateway-threshold-reader.ts`. The cell sits between the per-conversation override (most specific) and the global defaults; the winning threshold feeds `DefaultApprovalPolicy.evaluate` as `autoApproveUpTo`, composing cell RiskThreshold × tool RiskLevel with the untouched capability floor (`resolveSensitiveToolDecision`). Fail-safe semantics: a cell transport failure falls through to global on the cached read, but the pre-prompt refresh keeps its prompt (returns null) rather than falling through to a possibly-looser global. Slack non-DMs resolve with no conversation type (the gateway forwards public and private alike as `"channel"`), so the `channel_type` tier only matches DMs/groups until the gateway forwards the distinction.

### Trust Classes → Capabilities (what an actor may do)

Two orthogonal axes, do not conflate them:

- **Admission** (above) — _who gets in the door_. `TRUST_CLASS_RANK` vs `ADMISSION_FLOOR`, enforced across gateway + runtime.
- **Capabilities** — _what an actor may do once admitted_. Resolved in the runtime, never on the gateway.

**Trust classes** (`TrustClass` in `assistant/src/runtime/actor-trust-resolver.ts`) are the _role_, ranked by `TRUST_CLASS_RANK`:

| Class                | Rank | Meaning                                                                  |
| -------------------- | ---- | ------------------------------------------------------------------------ |
| `guardian`           | 4    | Matches the active guardian binding for this (assistant, channel).       |
| `trusted_contact`    | 3    | Active contact channel, not the guardian.                                |
| `unverified_contact` | 2    | Contact channel that is `pending`/`unverified` — known but not verified. |
| `unknown`            | 1    | No contact record, no identity, or blocked/revoked. Fail-closed.         |

The gateway classifies the actor at ingress (keyed on `actorExternalId`) and forwards the resolved `trustClass`; it is persisted in retry payloads, the journal store, and conversation CRUD. The gateway does **not** compute capabilities.

**Capability resolution** lives in `assistant/src/runtime/capabilities.ts`. `resolveCapabilities(trustClass) → CapabilitySet` is the **single fail-closed trust boundary** for the "what may they do" axis, separating permissions from the raw class the way RBAC separates permissions from roles:

- **Total & fail-closed.** Accepts any string or `undefined`; anything not a recognized class (incl. legacy strings like `"non_guardian"`) resolves to the `unknown` set. The lookup uses an own-property check so inherited keys (`"__proto__"`, `"constructor"`, `"toString"`) also fail closed.
- **`trusted_contact` ≡ `unverified_contact`.** They share the same `CapabilitySet` object — the distinction is admission-only. Pinned by `capabilities.test.ts`.
- **`CapabilitySet` fields**: `canSelfApproveTools`, `sensitiveToolApproval` (`self | escalate-and-wait | deny`), `canManageSchedules`, `canUseVerificationControlPlane`, `canSelfAuthorizeArchiveBySender`, `canAccessMemory`, `canAccessPrivilegedDocuments`, `canRunUnsandboxedShell`, `mayBeInteractive`, `canActUnderDiskPressureCleanup`, `promptTrustGuidance` (`none | social-engineering-defense | stranger-warning`). All the booleans except `mayBeInteractive` are guardian-only; `mayBeInteractive` is also true for contacts.

**How call sites use it.** Read a named capability instead of re-deriving from the raw class — e.g. `if (!resolveCapabilities(trustClass).canAccessMemory) skip`. Context-dependent decisions **compose** a capability primitive with runtime context rather than encoding it in the table: `resolveRoutingState` uses `mayBeInteractive && guardianRouteResolvable`; `document-tool` uses `canAccessPrivilegedDocuments || executionChannel === "vellum"`; the self-approval race guard uses `!canSelfApproveTools && <pending-row state>`. The legacy `isUntrustedTrustClass` helper has been removed — use `!resolveCapabilities(x).<cap>`.

**Stateless.** Capabilities are derived on read from the already-persisted/forwarded `trustClass`; nothing capability-shaped is stored or sent on the wire.

**Adding a capability**: add the field to `CapabilitySet` + the three class records (`GUARDIAN_CAPABILITIES`, `CONTACT_CAPABILITIES`, `UNKNOWN_CAPABILITIES`) + the `MATRIX` in `capabilities.test.ts`. **Adding a trust class**: add a member to `TrustClass` (the `Record<TrustClass, …>` tables then fail to compile until every column is filled) and a matrix row.

**Intentionally NOT capability-gated** (these are identity / admission-flow decisions, not permissions, and stay raw class checks): `calls/*` guardian-identity call routing, `inbound-message-handler` heartbeat/timezone side-effects, `surface-action-routes` drift-heal re-resolution, and `channel-retry-sweep` trust-class parsing.

## Guardian Requests (gateway-owned)

The gateway owns guardian approval requests and their delivery records: the `guardian_requests` and `guardian_request_deliveries` tables (`src/db/guardian-request-store.ts`), fronted by `src/approvals/guardian-request-service.ts` and exposed to the daemon over the `guardian_requests_*` IPC routes (`src/ipc/guardian-request-handlers.ts`; shared contract in `packages/gateway-client/src/guardian-request-contract.ts`). The daemon holds no request state — it relays everything through `assistant/src/channels/gateway-guardian-requests.ts` and keeps the daemon-domain side effects: notifications, card delivery/withdrawal, pending-interaction resume, grant minting into its `scoped_approval_grants`.

- **Decide atomicity (the core invariant).** `guardian_requests_decide` commits the status CAS (`pending → approved|denied`, first-writer-wins) and the decision's ACL outcome (`activate_member`, `seed_unverified`, `block`, `mint_outbound_session`) in ONE gateway transaction. A failed outcome rolls back the CAS — the request stays `pending` and the guardian can decide again; an `approved` request without its ACL write cannot exist, and deciding twice never applies two outcomes. There is no reopen path.
- **Schema notes.** There is no `source_type` column — the wire DTO's `sourceType` is derived from `source_channel` (`phone` → voice, `vellum` → desktop, else channel), and the list route translates a `sourceType` filter into `source_channel` predicates. The requester-side conversation is `source_conversation_id`. Request ids are caller-supplied and load-bearing (deterministic access-request ids; `tool_approval` rows reuse the pending-interaction id as PK).
- **Expiry is daemon-keyed for interaction-bound kinds.** `tool_approval`/`pending_question` requests die with the daemon's in-memory `pendingInteractions` map, so the daemon calls `guardian_requests_expire_interaction_bound` at boot; the gateway never expires them on its own restart. Persistent kinds (`access_request`, `tool_grant_request`) expire past `expires_at` via the daemon's 60s `guardian_requests_sweep_expired` sweep, which returns the expired rows for daemon-side card withdrawal and requester notices.
- **Provenance.** The tables moved here from the assistant DB: gateway data migration m0015 backfilled them, and m0016 (checkpoint-gated on m0015, with a final catch-up copy) dropped the assistant-side tables.
