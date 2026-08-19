# Permissions: Agent Instructions

This directory is the assistant's **client** of gateway-owned risk classification and trust rules, plus the assistant-owned decision that follows. Keep the split:

- **Gateway owns:** risk classification (`gateway/src/risk/*`, entered through the `classify_risk` IPC method), the trust rules that lower or raise a classified risk (applied inside the gateway classifiers and surfaced only as the classified level plus `matchType: "user_rule"`), the auto-approve thresholds and channel-permission cells, and the per-actor `TrustClass` verdict.
- **Assistant owns:** the turn's actor and its capabilities (`runtime/capabilities.ts`), the sensitive-tool capability floor (`tools/tool-approval-handler.ts`), the allow / prompt / deny decision over risk × threshold × capabilities (`check()` here, `DefaultApprovalPolicy`), the prompt UX (`prompter.ts`), execution, and the `tool_invocations` audit row.

Rules that follow from the split:

- **Do not add a risk classifier, risk table, or trust-rule matcher under `assistant/src`.** If a tool's risk is wrong or a rule cannot cover it, the fix is in `gateway/src/risk/` (or the tool's `defaultRiskLevel`, which the gateway uses for tools without a dedicated classifier).
- **Classify once per tool invocation.** `classifyRisk()` is the only call into the gateway; the executor takes it before the pre-execution gates and hands the result to `checkPermission` and `check()`. Do not re-classify downstream, and do not memoise the result in the daemon: the inputs (rules, config, skill content) change out from under it, and the gateway already memoises the expensive part.
- **Read the classification, do not re-derive it.** The allowlist ladder is `classification.allowlistOptions`; there are no per-tool option builders here. Elevations, `matchType` checks, and option ladders come from the `RiskClassificationWithMeta` the gateway returned. A daemon-side "defense in depth" copy of a gateway rule is a second source of truth, not a defense.
- **Types cross the boundary from the wire contract.** The `classify_risk` request and response are `ClassifyRiskIpcParamsSchema` / `ClassifyRiskIpcResponseSchema` in `@vellumai/gateway-client`; fields the daemon carries from the response are typed off `ClassifyRiskIpcResponse`, never re-declared. `src/__tests__/risk-classification-boundary-guard.test.ts` pins the single call site and the absence of local classifiers.
- The one daemon-side adjustment to a classification is the bash sandbox symlink-escape re-check (`applyBashSymlinkEscapeCheck`), because it needs the assistant's filesystem; it only ever revokes auto-approve.

The architecture doc for this area is [`docs/architecture/security.md`](../../docs/architecture/security.md).
