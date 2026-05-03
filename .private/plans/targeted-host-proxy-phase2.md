# Phase 2 Implementation Plan: Targeted Host Proxy Routing

**Feature branch:** `Credence/targeted-host-proxy-phase2`
**Reference:** `host-bash-proxy.ts` + `host-bash-routes.ts` (Phase 1, PR #29322, merged)

---

## PR 1 — Core proxy changes: `HostFileProxy` + `HostProxyBase` + message types

**Title:** `feat(host-proxy): add targetClientId support to HostFileProxy and HostProxyBase`

### Files changed

**`assistant/src/daemon/message-types/host-file.ts`** (+3 lines)
- Add `targetClientId?: string` to each of the three request variants (`HostFileReadRequest`, `HostFileWriteRequest`, `HostFileEditRequest`). Field sits next to `conversationId` on each interface.

**`assistant/src/daemon/message-types/host-cu.ts`** (+1 line)
- Add `targetClientId?: string` to `HostCuRequest`.

**`assistant/src/daemon/host-file-proxy.ts`** (~+40 lines)
- Add `targetClientId?: string` to `PendingRequest` interface.
- Add `targetClientId?: string` to `request()` input type (already uses `HostFileInput` which is a distributive omit of the message type — the new field propagates automatically once added to the message types).
- Insert target-resolution block at the top of `request()` — exact mirror of `host-bash-proxy.ts:87–103`: explicit validate-connected-and-capable → single-capable auto-resolve → `undefined`.
  - Capability name: `"host_file"` (already used in `isAvailable()`).
- Thread `resolvedTargetClientId` to both `broadcastMessage` calls (request + cancel) as second conversationId arg and `{ targetClientId: resolvedTargetClientId }` options — same pattern as `host-bash-proxy.ts:178–193` and `147–156`.
- Add `targetClientId: resolvedTargetClientId` to `this.pending.set(...)` entry.
- In dispose loop, pass `targetClientId: entry.targetClientId` to the cancel `broadcastMessage` call.
- Update timeout message to include `resolvedTargetClientId` when set (mirror `host-bash-proxy.ts:125–127`).

**`assistant/src/daemon/host-proxy-base.ts`** (~+20 lines)
- Add `targetClientId?: string` to `PendingEntry<TResultPayload>`.
- Change `broadcastDynamic` signature: `function broadcastDynamic(envelope: Record<string, unknown>, targetClientId?: string): void` — pass `targetClientId` as options to `broadcastMessage`: `broadcastMessage(envelope as unknown as ServerMessage, undefined, targetClientId ? { targetClientId } : undefined)`.
  - Note: `broadcastMessage`'s second arg is `conversationId` (optional string). Pass `undefined` there; the hub already calls `extractConversationId(msg)` internally. The `conversationId` is already embedded in the envelope.
- Update `dispatchRequest` signature: add `targetClientId?: string` after `signal?: AbortSignal` (as 6th arg after `extraFields?`).
- Thread `targetClientId` to `broadcastDynamic` at the request-send site, the abort cancel site, and the dispose cancel site.
- Store `targetClientId` in `this.pending.set(requestId, { ..., targetClientId })`.
- In `HostCuProxy.request()` (`host-cu-proxy.ts`): add `targetClientId?: string` parameter, pass to `this.dispatchRequest(toolName, input, conversationId, signal, { stepNumber, reasoning }, targetClientId)`.

**`assistant/src/runtime/assistant-event-hub.ts`** (+2 lines)
- In `registerPendingInteraction`, update the `host_file_request` branch to include `targetClientId` in the registered interaction.
- Update the `host_cu_request` branch identically.
- The `targetClientId` parameter is already passed into `registerPendingInteraction` from `broadcastMessage` — it just wasn't forwarded to these two branches.

### Key implementation notes
- `HostFileProxy` is a standalone singleton (same shape as `HostBashProxy`) — copy the resolution block verbatim, swapping `"host_bash"` → `"host_file"` and the error message client-id text.
- `broadcastDynamic` is module-private to `host-proxy-base.ts`. Changing its signature is a contained local change.
- `HostCuProxy` extends `HostProxyBase` and currently calls `dispatchRequest` with 5 args. Adding `targetClientId` as a 6th optional arg maintains backward compatibility for all existing call sites.
- The `HostFileInput` type is derived from `HostFileRequest` via `DistributiveOmit`, so adding `targetClientId?` to the message type automatically adds it to `HostFileInput` — no separate change needed.

**Estimated diff:** ~70 lines net added across 5 files.

---

## PR 2 — Route validation: `x-vellum-client-id` guard on host-file-result and host-cu-result

**Title:** `feat(routes): enforce targetClientId binding on host-file-result and host-cu-result`

### Files changed

**`assistant/src/runtime/routes/host-file-routes.ts`** (~+25 lines)
- Import `ForbiddenError` (add to existing import of `BadRequestError`, `ConflictError`, `NotFoundError`).
- Add `headers` to destructured `RouteHandlerArgs` in `handleHostFileResult`.
- After `peeked.kind !== "host_file"` check, add the client-id validation block — exact copy of `host-bash-routes.ts:40–67`:
  ```ts
  const submittingClientId = headers?.["x-vellum-client-id"]?.trim() || undefined;
  const { targetClientId } = peeked;
  if (targetClientId) {
    if (!submittingClientId) throw new BadRequestError("x-vellum-client-id header is required for targeted host file requests");
    if (submittingClientId !== targetClientId) throw new ForbiddenError(`Client "${submittingClientId}" is not the target...`);
  }
  ```
- Add `additionalResponses` to the route definition (`"400"` and `"403"` entries).

**`assistant/src/runtime/routes/host-cu-routes.ts`** (~+25 lines)
- Same pattern as `host-file-routes.ts` above.
- `handleHostCuResult` currently destructures only `{ body }`. Change to `{ body, headers }`.
- The validation block inserts between the `peeked.kind !== "host_cu"` check and `pendingInteractions.resolve(requestId)`.

### Key implementation notes
- The `pendingInteractions.get(requestId)` call returns the full `PendingInteraction` which now carries `targetClientId` (set in PR 1). No changes to `pending-interactions.ts` itself.
- Keep request pending on 403 — do NOT call `pendingInteractions.resolve(requestId)` before throwing `ForbiddenError`. The broadcast retry from a correct client will re-attempt. This matches the host-bash-routes behavior.
- `RouteHandlerArgs` already includes `headers?: Record<string, string>` — no type changes needed there.

**Estimated diff:** ~50 lines net added across 2 files.

---

## PR 3 — Tool schemas + executors: `target_client_id` threading

**Title:** `feat(tools): add target_client_id to host_file_* and computer_use_* tools`

### Files changed

**`assistant/src/tools/host-filesystem/read.ts`** (+12 lines)
- Add to `input_schema.properties`:
  ```json
  "target_client_id": {
    "type": "string",
    "description": "ID of the specific client to execute this on. Required when multiple clients support host_file; omit when only one is connected."
  }
  ```
- In `execute()`: extract `const targetClientId = typeof input.target_client_id === "string" && input.target_client_id !== "" ? input.target_client_id : undefined;`
- Add multi-client guard: if `targetClientId == null && !supportsHostProxy(transportInterface) && listClientsByCapability("host_file").length > 1` → return error (mirror `host-shell.ts:208–218`). Import `assistantEventHub`, `supportsHostProxy`.
- Pass `targetClientId` to `HostFileProxy.instance.request({ operation: "read", ..., targetClientId }, ...)`.

**`assistant/src/tools/host-filesystem/write.ts`** (+12 lines)
- Same schema addition, same extraction, same guard, pass `targetClientId` to proxy request.

**`assistant/src/tools/host-filesystem/edit.ts`** (+12 lines)
- Same. The proxy call is at line 90: `HostFileProxy.instance.request({ operation: "edit", ..., targetClientId }, ...)`.

**`assistant/src/tools/computer-use/definitions.ts`** (~+50 lines)
- Add `target_client_id` property to `input_schema.properties` for the 8 action tools (click, type_text, key, scroll, drag, wait, open_app, run_apple_script). **Skip** `computer_use_done` and `computer_use_respond` (terminal — no client round-trip).
- Description: `"ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected."`
- Do NOT add to `required` arrays.

**`assistant/src/daemon/conversation-surfaces.ts`** (+8 lines)
- In `surfaceProxyResolver`, before calling `ctx.hostCuProxy.request(...)`, extract:
  ```ts
  const targetClientId = typeof input.target_client_id === "string" && input.target_client_id !== "" ? input.target_client_id : undefined;
  ```
- Add same multi-client guard as host-shell.ts (if `targetClientId == null && non-host-proxy interface && > 1 capable client → error`). Import `supportsHostProxy`, `assistantEventHub`.
- Pass `targetClientId` as the new last argument to `ctx.hostCuProxy.request(toolName, input, ctx.conversationId, ctx.hostCuProxy.stepCount, reasoning, signal, targetClientId)`.

**`assistant/src/daemon/host-cu-proxy.ts`** (+3 lines)
- Update `request()` signature to accept `targetClientId?: string` as last param (after `signal?`).
- Pass `targetClientId` as new last arg to `this.dispatchRequest(toolName, input, conversationId, signal, { stepNumber, reasoning }, targetClientId)`.

### Key implementation notes
- `host_file_read/write/edit` currently call `HostFileProxy.instance.request(input, conversationId, signal)`. The `HostFileInput` type is already updated in PR 1 to include `targetClientId?`, so the extra field slots in cleanly.
- The multi-client guard pattern for `host_file` mirrors `host-shell.ts:205–218`. Capability: `"host_file"`.
- For CU tools: `target_client_id` inside `input` is forwarded to the client as part of the nested `input` field in the `host_cu_request` envelope. This is benign — the client ignores unknown fields in `input`.
- The `dispatchRequest` call in `HostCuProxy` currently has 5 args; the updated base signature adds `targetClientId` as arg 6. Existing call sites in tests pass 5 args which remain valid (optional param).

**Estimated diff:** ~100 lines net added across 6 files.

---

## PR 4 — Swift / macOS: acceptance guard + result header for host_file and host_cu

**Title:** `feat(macos): targetClientId acceptance guard and result header for host_file and host_cu`

### Files changed

**`clients/shared/Network/MessageTypes.swift`** (+10 lines)
- `HostFileRequest`: add `public let targetClientId: String?` property. Add `case targetClientId` to `CodingKeys`. Mirrors `HostBashRequest` lines 1549–1561.
- `HostCuRequest`: same additions (`targetClientId: String?` + CodingKey case).

**`clients/shared/Network/EventStreamClient.swift`** (+4 lines)
- In `shouldIgnoreHostToolRequest`, update the `.hostFileRequest` case:
  ```swift
  case .hostFileRequest(let msg):
      if msg.targetClientId != nil { return false }  // pass through targeted requests
      if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
      log.warning(...)
      return true
  ```
- Same for `.hostCuRequest` case (+1 line each).

**`clients/macos/vellum-assistant/App/AppDelegate+ConnectionSetup.swift`** (+16 lines)
- For `.hostFileRequest`: replace the current 1-line `HostToolExecutor.executeHostFileRequest(msg)` with the `isTargeted || isUntargetedLocal` guard block (8 lines, same shape as `.hostBashRequest`).
- For `.hostCuRequest`: add the same `isTargeted || isUntargetedLocal` guard before the existing `let proxy = ...` / `Task { ... }` block.

**`clients/shared/Network/HostProxyClient.swift`** (+2 lines)
- `postFileResult`: add `extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()]` to `GatewayHTTPClient.post(...)`. Mirrors `postBashResult` line 28.
- `postCuResult`: same addition.

### Key implementation notes
- `DeviceIdStore.getOrCreate()` is already imported in this module (used in `postBashResult`).
- The `isTargeted || isUntargetedLocal` guard for `.hostCuRequest` wraps the entire existing `let proxy = ... / Task { ... } / self.inFlightCuTasks[...] = task` block — guard goes at the top.
- Do NOT modify `HostCuActionRunner.perform()` or the result payload shape — `targetClientId` is in the header only, not the body.
- `postFileResult` has dynamic timeout logic — `extraHeaders` addition is orthogonal to it.

**Estimated diff:** ~35 lines net added across 4 files.

---

## PR 5 — Tests

**Title:** `test(host-proxy): unit + route + regression tests for Phase 2 targetClientId`

### Files changed

**`assistant/src/__tests__/host-file-proxy-targeted.test.ts`** (new, ~80 lines)
- `HostFileProxy.request()` with explicit `targetClientId` → validates client connected + capable, sends `broadcastMessage` with `targetClientId` in options.
- Auto-resolve when exactly one `host_file`-capable client connected.
- Error when explicit `targetClientId` references unknown/incapable client.
- `targetClientId` included in cancel broadcast on abort.
- `targetClientId` included in cancel broadcast on dispose.
- Timeout message includes `targetClientId` when set.

**`assistant/src/__tests__/host-proxy-base-targeted.test.ts`** (new, ~60 lines)
- `HostProxyBase.dispatchRequest()` stores `targetClientId` in pending entry.
- Broadcasts with `targetClientId` option on request send.
- Broadcasts with `targetClientId` on abort cancel.
- Broadcasts with `targetClientId` on dispose cancel.
- `targetClientId` round-trips through `PendingEntry` to cancel paths.

**`assistant/src/__tests__/host-file-routes-targeted.test.ts`** (new, ~70 lines)
- `POST /v1/host-file-result` with `targetClientId` set in pending interaction:
  - Missing `x-vellum-client-id` header → 400.
  - Wrong client ID → 403, request stays pending.
  - Correct client ID → 200 accepted.
- Without `targetClientId`: no header required → 200 accepted (regression).

**`assistant/src/__tests__/host-cu-routes-targeted.test.ts`** (new, ~70 lines)
- Same 4 cases as above for `POST /v1/host-cu-result`.

**Additions to existing test files** (folded in):
- `host-file-read-tool.test.ts`, `host-file-edit-tool.test.ts`, `host-file-write-tool.test.ts`: add one test case each — `target_client_id` in input → passed to proxy.
- Multi-client guard test (non-host-proxy interface + >1 capable client + no `target_client_id` → error).

**Estimated diff:** ~300 lines across 4 new files + additions to 3 existing test files.

---

## Final PR — Feature branch merge

**Title:** `feat: Phase 2 targeted host proxy routing for host_file and host_cu`

- `Credence/targeted-host-proxy-phase2 → main`
- No code changes — merge surface for final review.
- Checklist: PR 1–5 merged into feature branch, CI green, manual smoke test of targeted `host_file_read` and targeted `computer_use_click` from a non-owning client.

---

## Dependency order

```
PR1 (proxy + types) → PR2 (routes) → PR3 (tool schemas/executors)
PR1 → PR4 (Swift)
PR1 + PR2 + PR3 → PR5 (tests)
```

PR2 and PR3 can be opened in parallel once PR1 merges into the feature branch.
PR4 is independent of PR2/PR3.
