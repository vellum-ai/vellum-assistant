# Service Communication Matrix + Client Packages

## Overview
Create a source-of-truth inventory for all assistant/gateway/CES service-to-service communication (direction + protocol + concrete callsites), then extract those interactions into dedicated shared client packages under `packages/`. This removes duplicated transport/auth/timeout logic, makes cross-service boundaries explicit, and gives us one place to evolve each inter-service contract safely.

## PR 1: Add Service Communication Matrix + Guard
### Depends on
None

### Branch
service-comm-clients/pr-1-comm-matrix

### Title
docs(arch): add assistant-gateway-ces communication matrix and drift guard

### Files
- docs/service-communication-matrix.md
- scripts/service-communication/generate-matrix.ts
- scripts/service-communication/matrix-source.ts
- scripts/service-communication/__tests__/generate-matrix.test.ts
- ARCHITECTURE.md

### Implementation steps
1. Create `docs/service-communication-matrix.md` enumerating every currently observed permutation between the three services, including: caller service, callee service, protocol (`http`, `websocket`, `ipc-unix-ndjson`, `stdio-ndjson`, `unix-socket-ndjson`), auth mechanism, and concrete source files.
2. Add `scripts/service-communication/matrix-source.ts` with a typed list of expected callsite globs rooted in existing implementations (e.g. gateway runtime proxy routes, assistant gateway IPC client, assistant CES RPC client, gateway CES credential/log routes).
3. Implement `scripts/service-communication/generate-matrix.ts` to render the matrix markdown from that typed source, so edits are additive and reviewable instead of hand-maintained prose.
4. Add `scripts/service-communication/__tests__/generate-matrix.test.ts` to fail when matrix entries are malformed, duplicate a permutation key, or reference missing files.
5. Update `ARCHITECTURE.md` cross-service section to link to the new matrix doc as the canonical inventory for assistant/gateway/CES communications.

### Acceptance criteria
- Matrix document lists every existing assistant/gateway/CES communication direction and protocol with concrete callsites.
- A test fails when matrix entries drift or point to deleted files.
- Architecture docs link to the matrix as source of truth.

## PR 2: Scaffold `@vellumai/assistant-client`
### Depends on
None

### Branch
service-comm-clients/pr-2-assistant-client-pkg

### Title
feat(packages): add @vellumai/assistant-client shared gateway-to-assistant client

### Files
- packages/assistant-client/package.json
- packages/assistant-client/tsconfig.json
- packages/assistant-client/src/index.ts
- packages/assistant-client/src/http-client.ts
- packages/assistant-client/src/proxy-forward.ts
- packages/assistant-client/src/websocket-upstream.ts
- packages/assistant-client/src/__tests__/assistant-client.test.ts
- gateway/package.json

### Implementation steps
1. Create `packages/assistant-client` following existing package conventions (`type: module`, exact versions, `bun test src/`, NodeNext TS config).
2. Add `src/http-client.ts` with reusable assistant-runtime request helpers: upstream URL construction, service-token auth header injection, timeout handling, and hop-by-hop header stripping hooks.
3. Add `src/proxy-forward.ts` for request/response proxy forwarding behavior shared across gateway control-plane/admin routes (body buffering, timeout-to-504 mapping, connection-failure-to-502 mapping, response header sanitization).
4. Add `src/websocket-upstream.ts` for gateway-to-assistant upstream WebSocket URL/auth helper logic used by browser-relay, twilio relay/media, and STT stream routes.
5. Add focused package tests for URL normalization, auth header behavior, timeout mapping, and WS upstream token/query building.
6. Add `@vellumai/assistant-client` as a file dependency in `gateway/package.json` so downstream migration PRs do not need package.json churn.

### Acceptance criteria
- New package compiles/tests independently.
- Gateway depends on `@vellumai/assistant-client` without behavior changes yet.
- Shared helpers cover both HTTP proxy and WS upstream construction paths.

## PR 3: Migrate Gateway Runtime Client to `@vellumai/assistant-client`
### Depends on
PR 2

### Branch
service-comm-clients/pr-3-gw-runtime-client

### Title
refactor(gateway): route runtime client transport through @vellumai/assistant-client

### Files
- gateway/src/runtime/client.ts
- gateway/src/__tests__/runtime-client.test.ts
- gateway/src/http/routes/oauth-callback.ts
- gateway/src/http/routes/twilio-voice-webhook.ts

### Implementation steps
1. Replace in-file transport boilerplate in `gateway/src/runtime/client.ts` with `@vellumai/assistant-client` primitives while preserving existing circuit-breaker and retry semantics.
2. Keep existing exported gateway runtime-client API surface (`forwardToRuntime`, `forwardTwilio*`, `forwardOAuthCallback`, attachment helpers) so route callsites remain stable.
3. Update runtime-client tests to assert unchanged behavior for retry logic, 4xx handling, 5xx handling, and circuit-breaker state transitions.
4. Adjust any route imports/types only where needed to satisfy refactor without changing request/response behavior.

### Acceptance criteria
- Gateway runtime forwarding behavior is unchanged (tests pass).
- Transport/auth/timeout code in `runtime/client.ts` now delegates to package helpers.
- No route contract or status-code regressions.

## PR 4: Migrate Gateway Channel Control-Plane Proxies
### Depends on
PR 2

### Branch
service-comm-clients/pr-4-gw-control-proxies-a

### Title
refactor(gateway): move telegram/twilio/vercel/contacts control-plane proxying to assistant client

### Files
- gateway/src/http/routes/telegram-control-plane-proxy.ts
- gateway/src/http/routes/twilio-control-plane-proxy.ts
- gateway/src/http/routes/vercel-control-plane-proxy.ts
- gateway/src/http/routes/contacts-control-plane-proxy.ts
- gateway/src/__tests__/contacts-control-plane-proxy.test.ts

### Implementation steps
1. Replace duplicated `proxyToRuntime` implementations in these route files with shared forwarding helpers from `@vellumai/assistant-client`.
2. Preserve per-route logging namespaces and upstream path mapping so observability and behavior remain stable.
3. Ensure auth behavior stays service-token based (`gateway -> assistant`) and existing timeout/error mappings (504/502) are preserved.
4. Update/add tests for one route in this cluster to assert error mapping, header forwarding behavior, and successful body passthrough.

### Acceptance criteria
- No duplicated manual proxy transport code remains in the four migrated files.
- Route semantics (status mapping, headers, upstream path mapping) are unchanged.
- Existing route tests remain green with targeted coverage for the shared helper path.

## PR 5: Migrate OAuth/Slack/Pairing/Verification/Readiness/Health Proxies
### Depends on
PR 2

### Branch
service-comm-clients/pr-5-gw-control-proxies-b

### Title
refactor(gateway): migrate secondary control-plane/runtime-health proxy routes to assistant client

### Files
- gateway/src/http/routes/oauth-apps-proxy.ts
- gateway/src/http/routes/oauth-providers-proxy.ts
- gateway/src/http/routes/slack-control-plane-proxy.ts
- gateway/src/http/routes/pairing-proxy.ts
- gateway/src/http/routes/channel-verification-session-proxy.ts
- gateway/src/http/routes/channel-readiness-proxy.ts
- gateway/src/http/routes/runtime-health-proxy.ts

### Implementation steps
1. Apply the same shared proxy helper migration pattern to these routes, preserving each route’s path rewriting and special-case header rules (`x-forwarded-for` handling in verification/pairing paths).
2. Keep guardian bootstrap secret behavior and local/private checks intact by only replacing transport mechanics, not authorization logic.
3. Ensure readiness and health proxies still function even when broad runtime proxy is disabled.
4. Add/extend route tests for verification/pairing special handling to guard against regressions in client IP/header forwarding.

### Acceptance criteria
- These proxy routes use the shared package helper instead of per-file transport duplication.
- Verification/pairing bootstrap/security logic remains intact.
- Health/readiness behavior remains available under runtime-proxy-disabled configurations.

## PR 6: Migrate Runtime/Admin Proxies + WS Upstream Connectors
### Depends on
PR 2

### Branch
service-comm-clients/pr-6-gw-runtime-admin-ws

### Title
refactor(gateway): move runtime/admin proxy and upstream websocket transport to assistant client

### Files
- gateway/src/http/routes/runtime-proxy.ts
- gateway/src/http/routes/brain-graph-proxy.ts
- gateway/src/http/routes/upgrade-broadcast-proxy.ts
- gateway/src/http/routes/workspace-commit-proxy.ts
- gateway/src/http/routes/migration-proxy.ts
- gateway/src/http/routes/migration-rollback-proxy.ts
- gateway/src/http/routes/browser-relay-websocket.ts
- gateway/src/http/routes/twilio-relay-websocket.ts
- gateway/src/http/routes/twilio-media-websocket.ts
- gateway/src/http/routes/stt-stream-websocket.ts

### Implementation steps
1. Replace transport/auth boilerplate in runtime/admin HTTP proxy routes with `@vellumai/assistant-client` helper calls while preserving route-specific guards (e.g. `/webhooks/*` block in runtime proxy).
2. Migrate WS upstream URL/auth token construction in browser relay, twilio relay/media, and STT stream routes to the package’s WS helper, keeping downstream auth/authorization checks in route code.
3. Preserve buffer overflow handling and close-code propagation semantics in WS handlers; only upstream connection mechanics move to shared helpers.
4. Extend websocket route tests to assert unchanged upstream URL/token generation and close/error behavior.

### Acceptance criteria
- Runtime/admin proxy and WS routes no longer duplicate upstream transport construction.
- Route-specific security gates remain local and unchanged.
- Existing WebSocket behavior (buffering, close propagation, auth gates) is preserved.

## PR 7: Scaffold `@vellumai/gateway-client`
### Depends on
None

### Branch
service-comm-clients/pr-7-gateway-client-pkg

### Title
feat(packages): add @vellumai/gateway-client shared assistant-to-gateway client

### Files
- packages/gateway-client/package.json
- packages/gateway-client/tsconfig.json
- packages/gateway-client/src/index.ts
- packages/gateway-client/src/http-delivery.ts
- packages/gateway-client/src/http-trust-rules.ts
- packages/gateway-client/src/ipc-client.ts
- packages/gateway-client/src/types.ts
- packages/gateway-client/src/__tests__/gateway-client.test.ts
- assistant/package.json

### Implementation steps
1. Create `packages/gateway-client` with modules for assistant->gateway interactions currently implemented inside assistant.
2. Move generic HTTP delivery client behavior (currently in `assistant/src/runtime/gateway-client.ts`) into `http-delivery.ts`, including managed callback URL handling and retry/idempotency semantics.
3. Move trust-rule HTTP CRUD client behavior (currently in `assistant/src/permissions/trust-client.ts`) into `http-trust-rules.ts`, preserving sync/async variants and typed parsing.
4. Add `ipc-client.ts` for Unix-socket NDJSON calls used by feature flags, thresholds, and contacts lookups.
5. Add package tests for IPC framing/timeout behavior and HTTP auth/retry behavior.
6. Add `@vellumai/gateway-client` dependency to `assistant/package.json`.

### Acceptance criteria
- Package exposes assistant->gateway HTTP and IPC clients with typed interfaces.
- Package tests cover delivery, trust-rule calls, and IPC request/response framing.
- Assistant depends on package with no behavior change yet.

## PR 8: Adopt `@vellumai/gateway-client` for Assistant HTTP Calls
### Depends on
PR 7

### Branch
service-comm-clients/pr-8-assistant-gw-http

### Title
refactor(assistant): migrate gateway delivery and trust HTTP clients to @vellumai/gateway-client

### Files
- assistant/src/runtime/gateway-client.ts
- assistant/src/permissions/trust-client.ts
- assistant/src/__tests__/gateway-client-managed-outbound.test.ts
- assistant/src/__tests__/trust-store.test.ts

### Implementation steps
1. Refactor `assistant/src/runtime/gateway-client.ts` to delegate transport logic to `@vellumai/gateway-client/http-delivery` while preserving exported function signatures used across runtime routes/notifications.
2. Refactor `assistant/src/permissions/trust-client.ts` to delegate to `@vellumai/gateway-client/http-trust-rules` and keep local adapters for existing return types where needed.
3. Keep env resolution/token minting hooks injected at call sites so package stays transport-focused and assistant-owned auth context remains unchanged.
4. Update tests to validate unchanged error typing and managed outbound callback behavior.

### Acceptance criteria
- Assistant HTTP interactions with gateway are served by package clients.
- Existing assistant callsites require no behavioral changes.
- Gateway delivery and trust-rule regression tests pass unchanged.

## PR 9: Adopt `@vellumai/gateway-client` for Assistant IPC Calls
### Depends on
PR 7

### Branch
service-comm-clients/pr-9-assistant-gw-ipc

### Title
refactor(assistant): migrate gateway IPC reads (feature flags, thresholds, contacts) to @vellumai/gateway-client

### Files
- assistant/src/ipc/gateway-client.ts
- assistant/src/config/assistant-feature-flags.ts
- assistant/src/permissions/gateway-threshold-reader.ts
- assistant/src/__tests__/mock-gateway-ipc.ts

### Implementation steps
1. Replace assistant’s in-file gateway IPC socket implementation with wrappers over `@vellumai/gateway-client/ipc-client` while preserving existing method names and failure semantics (`undefined` on transport failure).
2. Update feature flag resolver and threshold reader to use the package IPC methods and shared typed responses.
3. Keep cache/TTL logic in assistant modules; only transport and response-shape parsing move to package.
4. Update mocking utilities/tests to hook package IPC layer cleanly without changing test intent.

### Acceptance criteria
- Assistant IPC calls now go through shared package code.
- Feature-flag and threshold behavior is unchanged (including fallback behavior on IPC failure).
- Existing IPC-related tests remain green.

## PR 10: Scaffold `@vellumai/ces-client`
### Depends on
None

### Branch
service-comm-clients/pr-10-ces-client-pkg

### Title
feat(packages): add @vellumai/ces-client shared CES HTTP/RPC client package

### Files
- packages/ces-client/package.json
- packages/ces-client/tsconfig.json
- packages/ces-client/src/index.ts
- packages/ces-client/src/http-credentials.ts
- packages/ces-client/src/http-log-export.ts
- packages/ces-client/src/rpc-client.ts
- packages/ces-client/src/__tests__/ces-client.test.ts
- assistant/package.json
- gateway/package.json

### Implementation steps
1. Create `packages/ces-client` with modules covering:
   - credential CRUD/list over CES HTTP (`/v1/credentials*`),
   - CES log export HTTP (`/v1/logs/export`),
   - CES RPC envelope/handshake client (currently assistant-owned implementation).
2. Port shared HTTP transport behavior (auth header, timeout, status mapping) into package helpers.
3. Port transport-agnostic RPC client core (envelope validation against `@vellumai/ces-contracts`) into `rpc-client.ts`, keeping transport interface-based design.
4. Add package tests for HTTP error handling and RPC handshake/request lifecycle.
5. Add `@vellumai/ces-client` dependency to assistant and gateway package manifests.

### Acceptance criteria
- Package provides reusable CES HTTP and RPC clients with typed contracts.
- Assistant and gateway depend on the package without behavior changes yet.
- Package tests pass and validate handshake/HTTP edge cases.

## PR 11: Adopt `@vellumai/ces-client` and Remove Duplicated CES HTTP Client Logic
### Depends on
PR 10

### Branch
service-comm-clients/pr-11-adopt-ces-client

### Title
refactor(assistant,gateway): migrate CES HTTP/RPC callsites to @vellumai/ces-client and delete duplicate client code

### Files
- assistant/src/security/ces-credential-client.ts
- assistant/src/credential-execution/client.ts
- assistant/src/security/secure-keys.ts
- gateway/src/credential-reader.ts
- gateway/src/credential-watcher.ts
- gateway/src/http/routes/log-export.ts
- gateway/src/__tests__/log-export.test.ts
- assistant/src/__tests__/ces-rpc-credential-backend.test.ts
- ARCHITECTURE.md

### Implementation steps
1. Refactor assistant CES credential backend and secure-keys integration to use `@vellumai/ces-client/http-credentials` instead of local HTTP client duplication.
2. Refactor assistant CES RPC client implementation to wrap `@vellumai/ces-client/rpc-client`, keeping assistant process-manager/transport wiring intact.
3. Refactor gateway CES credential reads/watch bootstrap and CES log export route to use `@vellumai/ces-client` HTTP modules.
4. Delete duplicate per-service CES HTTP request helpers once all callsites are migrated.
5. Update architecture docs to point to the three new client packages as the canonical inter-service client layer.

### Acceptance criteria
- Assistant and gateway CES HTTP/RPC interactions flow through `@vellumai/ces-client`.
- Duplicated CES client logic is removed from assistant/gateway code.
- Existing CES-related tests pass with unchanged runtime behavior.
