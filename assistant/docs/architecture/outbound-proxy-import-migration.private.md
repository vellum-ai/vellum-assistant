# Decouple assistant from outbound-proxy internals

The outbound-proxy will run as a separate process. The assistant must not import any outbound-proxy code — it communicates with the proxy exclusively through service calls (IPC/HTTP). This doc tracks every import site, grouped by what service boundary replaces it.

---

## Category 1: Proxy session lifecycle

The assistant currently creates proxy servers in-process via `createProxyServer()`, wires up MITM handlers, manages certs, and does routing/policy evaluation — all by importing outbound-proxy internals. In the new model, the proxy service owns all of this. The assistant asks it to start/stop sessions and receives connection details back.

### Production code

| File                                                | What it imports                                                                                                                                                                                                                                                                                                          | What replaces it                                                                                                                             | Status |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/tools/network/script-proxy/session-manager.ts` | `createProxyServer`, `ensureCombinedCABundle`, `ensureLocalCA`, `getCAPath`, `routeConnection`, `evaluateRequestWithApproval`, `stripQueryString`, `buildDecisionTrace` + types (`ProxyServerConfig`, `ProxySession`, `ProxySessionConfig`, `ProxySessionId`, `PolicyCallback`, `ProxyApprovalCallback`, `ProxyEnvVars`) | Service call: `POST /sessions` → returns `{ port, env }`. Proxy owns server creation, cert setup, routing, policy, and injection internally. | TODO   |

### Tests (move to outbound-proxy or delete)

| File                                                 | What it tests                                                                                                              | Disposition                 | Status |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------ |
| `src/__tests__/script-proxy-connect-tunnel.test.ts`  | CONNECT tunnel establishment (`createProxyServer`)                                                                         | Move to outbound-proxy      | TODO   |
| `src/__tests__/script-proxy-certs.test.ts`           | CA + leaf cert issuance (`ensureLocalCA`, `getCAPath`, `issueLeafCert`)                                                    | Move to outbound-proxy      | TODO   |
| `src/__tests__/script-proxy-http-forwarder.test.ts`  | HTTP forwarding (`createProxyServer`)                                                                                      | Move to outbound-proxy      | TODO   |
| `src/__tests__/script-proxy-mitm-handler.test.ts`    | MITM interception (`createProxyServer`, `ensureLocalCA`, `getCAPath`, `issueLeafCert`, `RewriteCallback`, `RouteDecision`) | Move to outbound-proxy      | TODO   |
| `src/__tests__/script-proxy-session-manager.test.ts` | Session manager + routing (`routeConnection` dynamic imports x3)                                                           | Rewrite against service API | TODO   |

---

## Category 2: Policy evaluation

The assistant imports policy functions to evaluate requests in the proxy's rewrite/policy callbacks. The proxy service will own policy evaluation internally — the assistant only needs to handle the approval prompt callback (the proxy asks "should I allow this?", the assistant answers).

### Production code

None beyond session-manager.ts (covered above).

### Tests (move to outbound-proxy)

| File                                                      | What it tests                                                        | Disposition            | Status |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------- | ------ |
| `src/__tests__/script-proxy-policy-runtime.test.ts`       | Policy runtime with approval callback (`ProxyApprovalCallback` type) | Move to outbound-proxy | TODO   |
| `src/__tests__/script-proxy-policy.test.ts`               | `evaluateRequest`, `evaluateRequestWithApproval`                     | Move to outbound-proxy | TODO   |
| `src/tools/network/script-proxy/__tests__/policy.test.ts` | `evaluateRequest`, `evaluateRequestWithApproval`                     | Move to outbound-proxy | TODO   |

---

## Category 3: Approval callback contract

The assistant needs to receive approval requests from the proxy service and respond. This is the one remaining contract between them — a callback interface, not an import.

| File                               | What it imports                                             | What replaces it                                                                                      | Status               |
| ---------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| `src/tools/types.ts`               | `ProxyApprovalCallback` (type-only)                         | Local types in `src/tools/types.ts` (`ProxyApprovalRequest`, `ProxyApprovalCallback`, `ProxyEnvVars`) | **DONE** (PR #12338) |
| `src/daemon/session-tool-setup.ts` | `ProxyApprovalCallback`, `ProxyApprovalRequest` (type-only) | Imports from `../tools/types.js`                                                                      | **DONE** (PR #12338) |

### Tests

| File                                            | Disposition                                                           | Status |
| ----------------------------------------------- | --------------------------------------------------------------------- | ------ |
| `src/__tests__/proxy-approval-callback.test.ts` | Keep in assistant — tests the assistant's side of the approval bridge | TODO   |

---

## Category 4: Logging and tracing utilities

The assistant imports sanitization and tracing helpers for proxy decision logging. These either move to the proxy (it logs internally) or become a thin shared utility.

| File                          | What it imports                           | What replaces it                                                                                                                                     | Status               |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `src/tools/terminal/shell.ts` | `buildCredentialRefTrace`, `ProxyEnvVars` | `buildCredentialRefTrace` inlined locally (removed from outbound-proxy — it's an assistant concern). `ProxyEnvVars` defined in `src/tools/types.ts`. | **DONE** (PR #12338) |

### Tests (move to outbound-proxy)

| File                                                       | What it tests                                                                                    | Disposition            | Status |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- | ------ |
| `src/__tests__/script-proxy-injection-runtime.test.ts`     | `createSafeLogEntry`, `sanitizeHeaders`                                                          | Move to outbound-proxy | TODO   |
| `src/__tests__/credential-security-invariants.test.ts`     | `createSafeLogEntry`, `sanitizeHeaders`, `sanitizeUrl`                                           | Move to outbound-proxy | TODO   |
| `src/__tests__/script-proxy-decision-trace.test.ts`        | `buildDecisionTrace`, trace types                                                                | Move to outbound-proxy | TODO   |
| `src/tools/network/script-proxy/__tests__/logging.test.ts` | `buildDecisionTrace`, `createSafeLogEntry`, `sanitizeHeaders`, `sanitizeUrl`, `stripQueryString` | Move to outbound-proxy | TODO   |

---

## Summary

| Category                   | Production files                    | Test files        | Status               |
| -------------------------- | ----------------------------------- | ----------------- | -------------------- |
| Proxy session lifecycle    | 1 (session-manager.ts)              | 5                 | TODO                 |
| Policy evaluation          | 0 (covered by session-manager)      | 3                 | TODO                 |
| Approval callback contract | 2 (types.ts, session-tool-setup.ts) | 1                 | **DONE** (PR #12338) |
| Logging/tracing            | 1 (shell.ts)                        | 4                 | **DONE** (PR #12338) |
| **Total**                  | **4 production → 2 remaining**      | **13 test files** |                      |

## After all imports are removed

- [ ] Delete `assistant/src/outbound-proxy/` directory entirely
- [ ] Remove any tsconfig path aliases pointing to the internal copy
- [ ] Define the proxy service API contract (session CRUD, approval callback IPC)
- [ ] `tsc --noEmit` + `lint` pass
- [ ] All remaining assistant tests pass
- [ ] All moved tests pass in outbound-proxy
