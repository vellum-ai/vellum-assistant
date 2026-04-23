# Service Communication Matrix Review Fixes

## Overview
Address 5 review findings from the post-merge review of the service communication matrix (PR #27865). Adds missing Gateway->Assistant WebSocket and HTTP permutations, adds missing threshold IPC entry, fixes the trust-rules callee globs, and expands drift-guard glob coverage for credential-watcher and risk-classification handlers. All changes are in `matrix-source.ts` with a regenerated markdown output.

## PR 1: Fix matrix entries and regenerate docs
### Depends on
None

### Branch
matrix-fixes/pr-1-matrix-entries

### Title
fix: address 5 review findings in service communication matrix

### Files
- `scripts/service-communication/matrix-source.ts`
- `docs/service-communication-matrix.md`

### Implementation steps

1. **Add 3 missing Gateway->Assistant WebSocket entries** in the `// Gateway -> Assistant (WebSocket)` section of `matrix-source.ts`, after the existing "Twilio ConversationRelay WebSocket proxy" entry:

   - **Browser relay WebSocket proxy**: `caller: "gateway"`, `callee: "assistant"`, `protocol: "websocket"`, `auth: "JWT Bearer (service token, query param)"`, description: "Gateway proxies Chrome extension browser-relay WebSocket frames to the assistant's /v1/browser-relay endpoint.", `callerGlobs: ["gateway/src/http/routes/browser-relay-websocket.ts"]`, `calleeGlobs: ["assistant/src/runtime/http-server.ts"]`.

   - **Twilio MediaStream WebSocket proxy**: `caller: "gateway"`, `callee: "assistant"`, `protocol: "websocket"`, `auth: "JWT Bearer (service token, query param)"`, description: "Gateway proxies Twilio MediaStream WebSocket frames to the assistant's /v1/calls/media-stream endpoint.", `callerGlobs: ["gateway/src/http/routes/twilio-media-websocket.ts"]`, `calleeGlobs: ["assistant/src/calls/media-stream-server.ts"]`.

   - **STT stream WebSocket proxy**: `caller: "gateway"`, `callee: "assistant"`, `protocol: "websocket"`, `auth: "JWT Bearer (service token, query param)"`, description: "Gateway proxies speech-to-text audio streams to the assistant's /v1/stt/stream WebSocket endpoint.", `callerGlobs: ["gateway/src/http/routes/stt-stream-websocket.ts"]`, `calleeGlobs: ["assistant/src/runtime/http-server.ts"]`.

2. **Fix auth on the existing ConversationRelay WebSocket entry.** Change `auth` from `"JWT Bearer (edge relay token, query param)"` to `"JWT Bearer (service token, query param)"`. The gateway calls `mintServiceToken()` (not edge relay token) for all upstream WS connections — see `twilio-relay-websocket.ts` L125-L130 where `buildWsUpstreamUrl` receives `serviceToken: mintServiceToken()`.

3. **Add missing "Threshold IPC" entry** in the `// Assistant -> Gateway (IPC Unix NDJSON)` section, after the existing "Risk classification IPC" entry:

   - `label: "Threshold IPC"`, `caller: "assistant"`, `callee: "gateway"`, `protocol: "ipc-unix-ndjson"`, `auth: "none (local socket)"`, description: "Assistant reads auto-approve threshold configuration from the gateway via IPC (get_global_thresholds, get_conversation_threshold methods).", `callerGlobs: ["assistant/src/permissions/gateway-threshold-reader.ts"]`, `calleeGlobs: ["gateway/src/ipc/threshold-handlers.ts", "gateway/src/ipc/server.ts"]`.

4. **Fix "Trust rules CRUD" callee globs.** In the existing trust-rules entry, replace `calleeGlobs: ["gateway/src/ipc/trust-rule-handlers.ts", "gateway/src/trust-store.ts"]` with `calleeGlobs: ["gateway/src/http/routes/trust-rules.ts", "gateway/src/trust-store.ts"]`. The protocol is HTTP and the callee is the HTTP route handler at `gateway/src/http/routes/trust-rules.ts`, not the IPC handler file. Keep `gateway/src/trust-store.ts` since the HTTP routes delegate to it.

5. **Add 2 missing Gateway->Assistant HTTP entries** in the `// Gateway -> Assistant (HTTP)` section, after the existing "Log export (daemon logs)" entry:

   - **Audio proxy**: `label: "Audio proxy"`, `caller: "gateway"`, `callee: "assistant"`, `protocol: "http"`, `auth: "none (audioId capability token)"`, description: "Gateway proxies Twilio TTS audio fetch requests to the assistant's /v1/audio/:audioId endpoint. The audioId is an unguessable UUID acting as a capability token.", `callerGlobs: ["gateway/src/http/routes/audio-proxy.ts"]`, `calleeGlobs: ["assistant/src/runtime/routes/audio-routes.ts"]`.

   - **Health and readiness probes**: `label: "Health and readiness probes"`, `caller: "gateway"`, `callee: "assistant"`, `protocol: "http"`, `auth: "JWT Bearer (service token)"`, description: "Gateway forwards /healthz and /readyz probes to the assistant's /v1/health and /readyz endpoints to verify full-stack readiness.", `callerGlobs: ["gateway/src/index.ts"]`, `calleeGlobs: ["assistant/src/runtime/http-server.ts"]`.

6. **Expand drift-guard glob coverage** on two existing entries:

   - In the "Gateway credential reads (HTTP)" entry, add `"gateway/src/credential-watcher.ts"` to `callerGlobs` (currently only `["gateway/src/credential-reader.ts"]`). The credential watcher also calls CES via `createCesHttpCredentialClient().list()`.

   - In the "Risk classification IPC" entry, add `"gateway/src/ipc/risk-classification-handlers.ts"` to `calleeGlobs` (currently only `["gateway/src/ipc/server.ts"]`). The handler implementation lives in that file, not just in `server.ts`.

7. **Regenerate the markdown matrix.** Run `bun run scripts/service-communication/generate-matrix.ts` from the repo root and commit the updated `docs/service-communication-matrix.md`.

### Acceptance criteria
- All 4 Gateway->Assistant WebSocket proxy permutations are present (browser-relay, twilio-media, stt-stream, twilio-relay) with correct `"JWT Bearer (service token, query param)"` auth.
- Threshold IPC entry exists with correct caller/callee globs.
- Trust rules CRUD calleeGlobs references `gateway/src/http/routes/trust-rules.ts` (not the IPC handler).
- Audio proxy and health/readiness probe HTTP entries exist.
- `credential-watcher.ts` is in the "Gateway credential reads" callerGlobs.
- `risk-classification-handlers.ts` is in the "Risk classification IPC" calleeGlobs.
- `docs/service-communication-matrix.md` is regenerated and reflects all new/updated entries.
- `bun test scripts/service-communication/__tests__/generate-matrix.test.ts` passes (drift guard validates all globs match existing files).
