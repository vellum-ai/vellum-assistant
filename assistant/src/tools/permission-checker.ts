import type {
  RiskAllowlistOption,
  RiskDirectoryScopeOption,
  RiskPatternScopeOption,
} from "@vellumai/gateway-client";

import { getIsContainerized } from "../config/env-registry.js";
import { mapApprovalProvenance } from "../permissions/approval-provenance.js";
import { buildChannelPermissionCellQuery } from "../permissions/channel-permission-query.js";
import {
  check,
  classifyRisk,
  generateScopeOptions,
  isDynamicSkillLoadInvocation,
  type RiskClassificationWithMeta,
} from "../permissions/checker.js";
import { getAutoApproveThreshold } from "../permissions/gateway-threshold-reader.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { isFullAccessThreshold } from "../permissions/threshold.js";
import type {
  ApprovalMode,
  ApprovalReason,
  RiskThreshold,
} from "../permissions/types.js";
import { RiskLevel } from "../permissions/types.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import {
  type PermissionPromptOutcome,
  type PermissionPromptTelemetry,
  recordToolDenied,
  recordToolPermissionDecided,
  recordToolPermissionPrompted,
} from "../telemetry/tool-audit.js";
import { getLogger } from "../util/logger.js";
import { resolveExecutionTarget } from "./execution-target.js";
import { getHostShell } from "./host-shell.js";
import { buildPolicyContext } from "./policy-context.js";
import { isSideEffectTool } from "./side-effects.js";
import type { Tool, ToolContext } from "./types.js";

const log = getLogger("permission-checker");

export type PermissionDecision =
  | {
      allowed: true;
      decision: string;
      riskLevel: string;
      wasPrompted?: boolean;
      /** ID of the trust rule that matched this invocation (if any). */
      matchedTrustRuleId?: string;
      /** Risk metadata from the invocation's classification. */
      riskMeta: {
        riskLevel: string;
        riskReason: string;
        riskScopeOptions: RiskPatternScopeOption[];
        riskAllowlistOptions?: RiskAllowlistOption[];
        riskDirectoryScopeOptions?: RiskDirectoryScopeOption[];
        isContainerized?: boolean;
      };
      approvalMode?: ApprovalMode;
      approvalReason?: ApprovalReason;
      riskThreshold?: RiskThreshold;
    }
  | {
      allowed: false;
      decision: string;
      riskLevel: string;
      content: string;
      /** ID of the trust rule that matched this invocation (if any). */
      matchedTrustRuleId?: string;
      /** Risk metadata from the invocation's classification. */
      riskMeta: {
        riskLevel: string;
        riskReason: string;
        riskScopeOptions: RiskPatternScopeOption[];
        riskAllowlistOptions?: RiskAllowlistOption[];
        riskDirectoryScopeOptions?: RiskDirectoryScopeOption[];
        isContainerized?: boolean;
      };
      approvalMode?: ApprovalMode;
      approvalReason?: ApprovalReason;
      riskThreshold?: RiskThreshold;
    };

export class PermissionChecker {
  private prompter: PermissionPrompter;

  constructor(prompter: PermissionPrompter) {
    this.prompter = prompter;
  }

  /**
   * Run trust rule evaluation and (if needed) user prompting for a tool
   * invocation. Returns whether the tool is allowed to execute, along with
   * the decision string and risk level for lifecycle event reporting.
   *
   * `classification` is the invocation's gateway classification when the
   * executor already holds it (it classifies once, before its gates); absent
   * that, the same input is classified here.
   */
  async checkPermission(
    name: string,
    input: Record<string, unknown>,
    tool: Tool,
    context: ToolContext,
    startTime: number,
    computePreviewDiff: (
      toolName: string,
      input: Record<string, unknown>,
      workingDir: string,
    ) => Promise<
      | {
          filePath: string;
          oldContent: string;
          newContent: string;
          isNewFile: boolean;
        }
      | undefined
    >,
    classification?: RiskClassificationWithMeta,
  ): Promise<PermissionDecision> {
    // Sandbox/host routing for the prompt comes from the tool's manifest.
    const executionTarget = resolveExecutionTarget(tool);
    classification ??= await classifyRisk(
      name,
      input,
      context.workingDir,
      undefined,
      undefined,
      context.signal,
      getHostShell(context, input),
    );
    const { level: risk, reason: riskReason } = classification;
    const riskLevel: string = risk;

    const riskMeta = {
      riskLevel: classification.level,
      riskReason: classification.reason,
      // Display ladder: bash only, internal, never persisted as a rule.
      riskScopeOptions: classification.scopeOptions,
      // Save ladder: the patterns the gateway matches a rule by, exactly.
      riskAllowlistOptions: classification.allowlistOptions,
      riskDirectoryScopeOptions: classification.directoryScopeOptions,
      isContainerized: getIsContainerized(),
    };

    // Wrap the rest of permission evaluation so that any exception
    // carries the classified risk level back to the caller. Without
    // this, the executor's catch block would fall back to the default
    // low risk, degrading audit/alert accuracy for high-risk attempts.
    try {
      const policyContext = buildPolicyContext(tool, context);
      const result = await check(
        name,
        input,
        context.workingDir,
        policyContext,
        undefined,
        context.signal,
        classification,
      );

      // Every threshold read for this invocation must consult the same
      // channel-permission cell that check() used — otherwise a follow-up
      // read of a looser global (the provenance snapshot below, the
      // non-interactive guardian auto-approve further down) would override a
      // stricter cell verdict. Derived once, from the same PolicyContext.
      const cellQuery = buildChannelPermissionCellQuery(policyContext);

      // Resolved threshold snapshot for provenance. getAutoApproveThreshold
      // returns from cache (populated by check() above), so this is free.
      const conversationThreshold = await getAutoApproveThreshold(
        policyContext.conversationId,
        policyContext.executionContext,
        cellQuery,
        policyContext.requesterContactId,
      );
      const riskThreshold = conversationThreshold as RiskThreshold;

      // Non-interactive callers (e.g. non-guardian phone voice) force
      // prompting for side-effect tools even when a trust/allow rule would
      // auto-allow, so their auto-deny handler always sees a
      // confirmation_request. Deny decisions are preserved — only
      // allow → prompt promotion happens here.
      if (
        context.forcePromptSideEffects &&
        result.decision === "allow" &&
        isSideEffectTool(name)
      ) {
        result.decision = "prompt";
        result.reason = "Side-effect tool requires explicit approval";
      }

      // requireFreshApproval independently promotes allow → prompt so that
      // cached grants, persistent trust rules, and auto-approve shortcuts
      // cannot bypass the interactive prompt. This is separate from the
      // forcePromptSideEffects path above to ensure requireFreshApproval
      // is self-sufficient without relying on SIDE_EFFECT_TOOLS membership.
      // At a full-access posture the user has opted into auto-approving even
      // high-risk tools, so the promotion is skipped.
      if (
        context.requireFreshApproval &&
        result.decision === "allow" &&
        !isFullAccessThreshold(riskThreshold)
      ) {
        result.decision = "prompt";
        result.reason =
          "Fresh approval required: per-invocation human review enforced";
      }

      if (result.decision === "deny") {
        recordToolDenied({
          conversationId: context.conversationId,
          toolName: name,
          input,
          reason: result.reason,
          riskLevel,
          durationMs: Date.now() - startTime,
        });
        const provenance = mapApprovalProvenance("denied", {});
        return {
          allowed: false,
          decision: "denied",
          riskLevel,
          content: result.reason,
          riskMeta,
          ...provenance,
          riskThreshold,
        };
      }

      // Inline-command ("dynamic") skill loads execute embedded shell at load
      // time. The sensitive-tool gate (tools/tool-approval-handler.ts, lane A)
      // already routes an uncovered one through the guardian-mediated capability
      // floor, so a non-guardian is escalated there and never reaches this lane.
      // The one thing that floor does not express is the absence of a human: an
      // uncovered dynamic load in a non-interactive session is denied here,
      // because embedded shell must never run unattended without a covering rule.
      // (A covering trust rule, matchType "user_rule", is left to proceed.)
      if (
        context.isInteractive === false &&
        isDynamicSkillLoadInvocation(name, input) &&
        classification.matchType !== "user_rule"
      ) {
        log.info(
          { toolName: name, riskLevel },
          "Denying uncovered inline-command skill load in non-interactive session",
        );
        recordToolDenied({
          conversationId: context.conversationId,
          toolName: name,
          input,
          reason:
            "Inline-command skill load requires human approval; no interactive client connected",
          riskLevel,
          durationMs: Date.now() - startTime,
        });
        return {
          allowed: false,
          decision: "denied",
          riskLevel,
          content: `Permission denied: tool "${name}" would load a skill containing inline command expansions, which execute shell commands at load time and require explicit human approval. No interactive client is connected. To allow this in non-interactive sessions, add a trust rule covering the skill via permission settings.`,
          riskMeta,
          ...mapApprovalProvenance("denied", {}),
          riskThreshold,
        };
      }

      // Platform-hosted mode: auto-approve sandboxed bash for guardians.
      // The sandbox provides the security boundary — prompting is unnecessary
      // friction. host_bash is excluded because it runs unsandboxed on the
      // user's machine and warrants explicit approval.
      // Deny rules are still respected (checked above). requireFreshApproval
      // is preserved as a belt-and-suspenders guard.
      if (
        result.decision === "prompt" &&
        context.isPlatformHosted &&
        name === "bash" &&
        resolveCapabilities(context.trustClass).canSelfApproveTools &&
        !context.requireFreshApproval
      ) {
        log.info(
          { toolName: name, riskLevel },
          "Auto-approving bash tool for platform-hosted guardian session",
        );
        return {
          allowed: true,
          decision: "platform_auto_approve",
          riskLevel,
          riskMeta,
          ...mapApprovalProvenance("platform_auto_approve", {}),
          riskThreshold,
        };
      }

      if (result.decision === "prompt") {
        // Guardian-trust sessions (e.g. scheduled jobs, reminders) should be
        // able to use bundled tools without interactive approval. The guardian
        // is the owner - prompting makes no sense when there is no client.
        // Exception: requireFreshApproval tools cannot be auto-approved -
        // without a human present, bundle installation must be denied.
        // Inline-command ("dynamic") skill loads are already denied above for
        // non-interactive sessions (embedded shell with no human to review it),
        // so they never reach this branch uncovered.
        // Exception: tools above the configured background threshold are
        // denied — unattended sessions must not auto-approve operations that
        // could cause significant damage if triggered by prompt injection
        // from untrusted content.
        if (
          context.isInteractive === false &&
          resolveCapabilities(context.trustClass).canSelfApproveTools &&
          !context.requireFreshApproval
        ) {
          // getAutoApproveThreshold returns from cache (populated by check() above).
          // Deferred inside the non-interactive branch so interactive prompts
          // don't pay the gateway I/O cost. The cell query is threaded through
          // so a strict channel cell governs this auto-approve too — without
          // it, a looser background global would silently bypass the cell.
          const bgThreshold = await getAutoApproveThreshold(
            context.conversationId,
            "background",
            cellQuery,
            context.requesterContactId,
          );
          const thresholdOrdinal: Record<string, number> = {
            none: -1,
            low: 0,
            medium: 1,
            high: 2,
          };
          const riskOrdinal: Record<string, number> = {
            [RiskLevel.Low]: 0,
            [RiskLevel.Medium]: 1,
            [RiskLevel.High]: 2,
          };
          const withinThreshold =
            (riskOrdinal[riskLevel] ?? 2) <=
            (thresholdOrdinal[bgThreshold] ?? 0);
          if (withinThreshold) {
            log.info(
              { toolName: name, riskLevel },
              "Auto-approving for non-interactive guardian session",
            );
            return {
              allowed: true,
              decision: "guardian_auto_approve",
              riskLevel,
              riskMeta,
              ...mapApprovalProvenance("guardian_auto_approve", {}),
              riskThreshold: bgThreshold as RiskThreshold,
            };
          }
        }

        // Non-interactive sessions have no client to respond to prompts -
        // deny immediately instead of blocking for the full permission timeout.
        if (context.isInteractive === false) {
          log.info(
            { toolName: name, riskLevel },
            "Auto-denying prompt for non-interactive session",
          );
          recordToolDenied({
            conversationId: context.conversationId,
            toolName: name,
            input,
            reason: "Non-interactive session: no client to approve prompt",
            riskLevel,
            durationMs: Date.now() - startTime,
          });
          return {
            allowed: false,
            decision: "denied",
            riskLevel,
            content: `Permission denied: tool "${name}" requires user approval but no interactive client is connected. The tool was not executed. To allow this tool in non-interactive sessions, add a trust rule via permission settings.`,
            riskMeta,
            ...mapApprovalProvenance("denied", {}),
            riskThreshold,
          };
        }

        const previewDiff = await computePreviewDiff(
          name,
          input,
          context.workingDir,
        );
        const promptOptions = {
          allowlistOptions: classification.allowlistOptions ?? [],
          scopeOptions: generateScopeOptions(context.workingDir, name),
          persistentDecisionsAllowed: !context.requireFreshApproval,
        };

        // Grouping dimensions shared by this prompt and its decision, so the
        // two series can be diffed by risk and by access preset without
        // parsing anything out of the event name.
        const promptTelemetry: PermissionPromptTelemetry = {
          toolName: name,
          riskLevel,
          riskThreshold,
          surface: context.executionChannel,
          conversationId: context.conversationId,
        };
        // An already-aborted signal makes the prompter return without
        // registering or sending a confirmation request, so nothing reaches
        // the user and neither half of the pair is recorded. `prompt()` reads
        // the same signal synchronously on entry, with no await in between, so
        // this check and its check always agree.
        const promptIsSurfaced = context.signal?.aborted !== true;
        if (promptIsSurfaced) {
          recordToolPermissionPrompted(promptTelemetry);
        }

        let response: Awaited<ReturnType<PermissionPrompter["prompt"]>>;
        try {
          response = await this.prompter.prompt(
            name,
            input,
            riskLevel,
            promptOptions.allowlistOptions,
            promptOptions.scopeOptions,
            previewDiff,
            context.conversationId,
            executionTarget,
            promptOptions.persistentDecisionsAllowed,
            context.signal,
            context.toolUseId,
            riskReason,
            getIsContainerized(),
            classification.directoryScopeOptions,
          );
        } catch (err) {
          // The prompter rejected rather than resolved: it was disposed while
          // this prompt was outstanding (client disconnect, conversation
          // teardown). Nobody answered, so the prompt is abandoned.
          if (promptIsSurfaced) {
            recordToolPermissionDecided(promptTelemetry, "abandoned");
          }
          throw err;
        }

        const decision = response.decision;

        // A prompt that ends without a human answer is abandoned, not denied.
        // The daemon resolves a timeout, a superseding user message, and a
        // turn abort to `deny` so the agent loop stops, but none of the three
        // is a decision the user made.
        let outcome: PermissionPromptOutcome;
        if (
          response.wasTimeout === true ||
          response.wasSystemCancel === true ||
          response.wasAbort === true
        ) {
          outcome = "abandoned";
        } else if (decision === "deny") {
          outcome = "deny";
        } else {
          outcome = "allow";
        }
        if (promptIsSurfaced) {
          recordToolPermissionDecided(promptTelemetry, outcome);
        }

        if (decision === "deny") {
          const contextualDenial =
            typeof response.decisionContext === "string"
              ? response.decisionContext.trim()
              : "";
          const denialMessage =
            contextualDenial.length > 0
              ? contextualDenial
              : `Permission denied. The "${name}" tool was not allowed. Do NOT retry this tool call immediately. Instead, explain that the action was not performed because permission was denied, and ask whether to try again or take a different approach. Wait for an explicit response before retrying.`;
          const denialReason =
            contextualDenial.length > 0
              ? `Permission denied (${name}): contextual policy`
              : "Permission denied by user";
          recordToolDenied({
            conversationId: context.conversationId,
            toolName: name,
            input,
            reason: denialReason,
            riskLevel,
            durationMs: Date.now() - startTime,
          });
          return {
            allowed: false,
            decision,
            riskLevel,
            content: denialMessage,
            riskMeta,
            ...mapApprovalProvenance(decision, {
              wasTimeout: response.wasTimeout,
              wasSystemCancel: response.wasSystemCancel,
              wasAbort: response.wasAbort,
            }),
            riskThreshold,
          };
        }

        return {
          allowed: true,
          decision,
          riskLevel,
          wasPrompted: true,
          riskMeta,
          ...mapApprovalProvenance(decision, { wasPrompted: true }),
          riskThreshold,
        };
      }

      // result.decision === 'allow'
      return {
        allowed: true,
        decision: "allow",
        riskLevel,
        riskMeta,
        ...mapApprovalProvenance("allow", {
          hasSandboxAutoApprove: result.hasSandboxAutoApprove,
        }),
        riskThreshold,
      };
    } catch (err) {
      if (err instanceof Error) {
        (err as Error & { riskLevel?: string }).riskLevel = riskLevel;
      }
      throw err;
    }
  }
}
