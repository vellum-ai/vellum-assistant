import { getIsContainerized } from "../config/env-registry.js";
import { mapApprovalProvenance } from "../permissions/approval-provenance.js";
import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
  getCachedAssessment,
} from "../permissions/checker.js";
import { getAutoApproveThreshold } from "../permissions/gateway-threshold-reader.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { ApprovalMode, ApprovalReason, RiskThreshold } from "../permissions/types.js";
import { RiskLevel } from "../permissions/types.js";
import { getLogger } from "../util/logger.js";
import { buildPolicyContext } from "./policy-context.js";
import { isSideEffectTool } from "./side-effects.js";
import type { ExecutionTarget } from "./types.js";
import type { Tool, ToolContext, ToolLifecycleEvent } from "./types.js";

const log = getLogger("permission-checker");

export type PermissionDecision =
  | {
      allowed: true;
      decision: string;
      riskLevel: string;
      wasPrompted?: boolean;
      /** ID of the trust rule that matched this invocation (if any). Always set when a rule matched, even for non-classifier tools where riskMeta is absent. */
      matchedTrustRuleId?: string;
      /** Risk metadata from the classifier assessment cache (when available). */
      riskMeta?: {
        riskLevel: string;
        riskReason: string;
        riskScopeOptions: Array<{ pattern: string; label: string }>;
        riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
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
      /** ID of the trust rule that matched this invocation (if any). Always set when a rule matched, even for non-classifier tools where riskMeta is absent. */
      matchedTrustRuleId?: string;
      /** Risk metadata from the classifier assessment cache (when available). */
      riskMeta?: {
        riskLevel: string;
        riskReason: string;
        riskScopeOptions: Array<{ pattern: string; label: string }>;
        riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
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
   * Run risk classification, trust rule evaluation, and (if needed) user
   * prompting for a tool invocation. Returns whether the tool is allowed
   * to execute, along with the decision string and risk level for lifecycle
   * event reporting.
   */
  async checkPermission(
    name: string,
    input: Record<string, unknown>,
    tool: Tool,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    emitLifecycleEvent: (event: ToolLifecycleEvent) => void,
    startTime: number,
    computePreviewDiff: (
      toolName: string,
      input: Record<string, unknown>,
      workingDir: string,
    ) =>
      | {
          filePath: string;
          oldContent: string;
          newContent: string;
          isNewFile: boolean;
        }
      | undefined,
  ): Promise<PermissionDecision> {
    const { level: risk, reason: riskReason } = await classifyRisk(
      name,
      input,
      context.workingDir,
      undefined,
      undefined,
      context.signal,
    );
    const riskLevel: string = risk;

    // Look up the cached assessment to extract risk metadata for the tool result.
    // This is populated by classifyRisk() for classifier-backed tools (bash, file, web, skill).
    // For tools without classifiers (e.g. MCP tools), the cache returns undefined.
    const cachedAssessment = getCachedAssessment(name, input);
    const riskMeta = cachedAssessment
      ? {
          riskLevel: cachedAssessment.riskLevel,
          riskReason: cachedAssessment.reason,
          riskScopeOptions: cachedAssessment.scopeOptions,
          riskDirectoryScopeOptions: cachedAssessment.directoryScopeOptions,
          isContainerized: getIsContainerized(),
        }
      : undefined;

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
      );

      // Extract the matched rule ID for propagation. Returned as a top-level
      // field on PermissionDecision so it reaches the executor even when
      // riskMeta is absent (non-classifier tools like MCP don't populate it).
      const matchedTrustRuleId = result.matchedRule?.id;

      // Resolved threshold snapshot for provenance. getAutoApproveThreshold
      // returns from cache (populated by check() above), so this is free.
      const conversationThreshold = await getAutoApproveThreshold(
        policyContext.conversationId,
        policyContext.executionContext,
      );
      const riskThreshold = conversationThreshold as RiskThreshold;

      // Some callers force prompting for side-effect tools even when a
      // trust/allow rule would auto-allow. Deny decisions are preserved -
      // only allow → prompt promotion happens here.
      if (
        context.forcePromptSideEffects &&
        result.decision === "allow" &&
        isSideEffectTool(name, input)
      ) {
        result.decision = "prompt";
        result.reason = "Side-effect tool requires explicit approval";
      }

      // requireFreshApproval independently promotes allow → prompt so that
      // cached grants, persistent trust rules, and auto-approve shortcuts
      // cannot bypass the interactive prompt. This is separate from the
      // forcePromptSideEffects path above to ensure requireFreshApproval
      // is self-sufficient without relying on SIDE_EFFECT_TOOLS membership.
      if (context.requireFreshApproval && result.decision === "allow") {
        result.decision = "prompt";
        result.reason =
          "Fresh approval required: per-invocation human review enforced";
      }

      if (result.decision === "deny") {
        const durationMs = Date.now() - startTime;
        emitLifecycleEvent({
          type: "permission_denied",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          riskReason,
          matchedTrustRuleId,
          decision: "deny",
          reason: result.reason,
          durationMs,
        });
        const provenance = mapApprovalProvenance("denied", { matchedTrustRuleId });
        return {
          allowed: false,
          decision: "denied",
          riskLevel,
          content: result.reason,
          matchedTrustRuleId,
          riskMeta,
          ...provenance,
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
        context.trustClass === "guardian" &&
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
          matchedTrustRuleId,
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
        // Exception: inline-command skill loads (skill_load_dynamic:*) must
        // never be silently auto-approved — they execute embedded commands
        // and require explicit human review or a pinned trust rule.
        // Exception: tools above the configured background threshold are
        // denied — unattended sessions must not auto-approve operations that
        // could cause significant damage if triggered by prompt injection
        // from untrusted content.
        const isDynamicSkillLoad =
          result.matchedRule?.pattern.startsWith("skill_load_dynamic:") ===
          true;
        if (
          context.isInteractive === false &&
          context.trustClass === "guardian" &&
          !context.requireFreshApproval &&
          !isDynamicSkillLoad
        ) {
          // getAutoApproveThreshold returns from cache (populated by check() above).
          // Deferred inside the non-interactive branch so interactive prompts
          // don't pay the gateway I/O cost.
          const bgThreshold = await getAutoApproveThreshold(
            context.conversationId,
            "background",
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
              matchedTrustRuleId,
              riskMeta,
              ...mapApprovalProvenance("guardian_auto_approve", {}),
              riskThreshold: bgThreshold as RiskThreshold,
            };
          }
        }

        // Non-interactive sessions have no client to respond to prompts -
        // deny immediately instead of blocking for the full permission timeout.
        if (context.isInteractive === false) {
          const durationMs = Date.now() - startTime;
          log.info(
            { toolName: name, riskLevel },
            "Auto-denying prompt for non-interactive session",
          );
          emitLifecycleEvent({
            type: "permission_denied",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            riskReason,
            matchedTrustRuleId,
            decision: "deny",
            reason: "Non-interactive session: no client to approve prompt",
            durationMs,
          });
          return {
            allowed: false,
            decision: "denied",
            riskLevel,
            content: `Permission denied: tool "${name}" requires user approval but no interactive client is connected. The tool was not executed. To allow this tool in non-interactive sessions, add a trust rule via permission settings.`,
            matchedTrustRuleId,
            riskMeta,
            // Do not pass matchedTrustRuleId here: an ask-rule match put us in
            // the prompt path, but the *reason* for denial is no interactive
            // client, not a deny rule. Always emit no_interactive_client.
            ...mapApprovalProvenance("denied", {}),
            riskThreshold,
          };
        }

        const previewDiff = computePreviewDiff(name, input, context.workingDir);
        const promptOptions = {
          allowlistOptions: await generateAllowlistOptions(
            name,
            input,
            context.signal,
          ),
          scopeOptions: generateScopeOptions(context.workingDir, name),
          persistentDecisionsAllowed: !context.requireFreshApproval,
        };

        emitLifecycleEvent({
          type: "permission_prompt",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          riskReason,
          reason: result.reason,
          allowlistOptions: promptOptions.allowlistOptions,
          scopeOptions: promptOptions.scopeOptions,
          diff: previewDiff,
          persistentDecisionsAllowed: promptOptions.persistentDecisionsAllowed,
        });

        const response = await this.prompter.prompt(
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
          cachedAssessment?.directoryScopeOptions,
        );

        const decision = response.decision;

        if (decision === "deny") {
          const contextualDenial =
            typeof response.decisionContext === "string"
              ? response.decisionContext.trim()
              : "";
          const denialMessage =
            contextualDenial.length > 0
              ? contextualDenial
              : `Permission denied by user. The user chose not to allow the "${name}" tool. Do NOT retry this tool call immediately. Instead, tell the user that the action was not performed because they denied permission, and ask if they would like you to try again or take a different approach. Wait for the user to explicitly respond before retrying.`;
          const denialReason =
            contextualDenial.length > 0
              ? `Permission denied (${name}): contextual policy`
              : "Permission denied by user";
          const durationMs = Date.now() - startTime;
          emitLifecycleEvent({
            type: "permission_denied",
            toolName: name,
            executionTarget,
            input,
            workingDir: context.workingDir,
            conversationId: context.conversationId,
            requestId: context.requestId,
            riskLevel,
            riskReason,
            matchedTrustRuleId,
            decision: "deny",
            reason: denialReason,
            durationMs,
          });
          return {
            allowed: false,
            decision,
            riskLevel,
            content: denialMessage,
            matchedTrustRuleId,
            riskMeta,
            ...mapApprovalProvenance(decision, {
              wasTimeout: response.wasTimeout,
              wasSystemCancel: response.wasSystemCancel,
            }),
            riskThreshold,
          };
        }

        return {
          allowed: true,
          decision,
          riskLevel,
          wasPrompted: true,
          matchedTrustRuleId,
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
        matchedTrustRuleId,
        riskMeta,
        ...mapApprovalProvenance("allow", {
          hasSandboxAutoApprove: result.hasSandboxAutoApprove,
          matchedTrustRuleId,
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
