import { getConfig } from "../config/loader.js";
import { getHookManager } from "../hooks/manager.js";
import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
} from "../permissions/checker.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { addRule } from "../permissions/trust-store.js";
import {
  getEffectiveMode,
  setConversationMode,
  setTimedMode,
} from "../runtime/conversation-approval-overrides.js";
import { getLogger } from "../util/logger.js";
import { buildPolicyContext } from "./policy-context.js";
import { isSideEffectTool } from "./side-effects.js";
import { wrapCommand } from "./terminal/sandbox.js";
import type { ExecutionTarget } from "./types.js";
import type { Tool, ToolContext, ToolLifecycleEvent } from "./types.js";

const log = getLogger("permission-checker");

export type PermissionDecision =
  | { allowed: true; decision: string; riskLevel: string }
  | { allowed: false; decision: string; riskLevel: string; content: string };

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
    sanitizeToolInput: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>,
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
    const risk = await classifyRisk(
      name,
      input,
      context.workingDir,
      undefined,
      undefined,
      context.signal,
    );
    const riskLevel: string = risk;

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

      // Private conversations force prompting for side-effect tools even when a
      // trust/allow rule would auto-allow. Deny decisions are preserved -
      // only allow → prompt promotion happens here.
      if (
        context.forcePromptSideEffects &&
        result.decision === "allow" &&
        isSideEffectTool(name, input)
      ) {
        result.decision = "prompt";
        result.reason =
          "Private conversation: side-effect tools require explicit approval";
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
          decision: "deny",
          reason: result.reason,
          durationMs,
        });
        return {
          allowed: false,
          decision: "denied",
          riskLevel,
          content: result.reason,
        };
      }

      if (result.decision === "prompt") {
        // dangerouslySkipPermissions: when enabled, auto-approve all prompts
        // without user interaction. Deny rules are still respected (they
        // return before reaching this block).
        //
        // Note: unlike guardian auto-approve and temporary overrides below,
        // this intentionally does NOT check `context.requireFreshApproval`.
        // The setting is designed to skip ALL interactive prompts
        // unconditionally — it is an explicit operator opt-out from the
        // permission system, so requireFreshApproval does not apply.
        const cfg = getConfig();
        if (cfg.permissions.dangerouslySkipPermissions) {
          log.info(
            { toolName: name, riskLevel },
            "dangerouslySkipPermissions active — auto-approving without prompt",
          );
          return { allowed: true, decision: "dangerously_skip_permissions", riskLevel };
        }

        // Guardian-trust sessions (e.g. scheduled jobs, reminders) should be
        // able to use bundled tools without interactive approval. The guardian
        // is the owner - prompting makes no sense when there is no client.
        // Exception: requireFreshApproval tools cannot be auto-approved -
        // without a human present, bundle installation must be denied.
        // Exception: inline-command skill loads (skill_load_dynamic:*) must
        // never be silently auto-approved — they execute embedded commands
        // and require explicit human review or a pinned trust rule.
        const isDynamicSkillLoad =
          result.matchedRule?.pattern.startsWith("skill_load_dynamic:") ===
          true;
        if (
          context.isInteractive === false &&
          context.trustClass === "guardian" &&
          !context.requireFreshApproval &&
          !isDynamicSkillLoad
        ) {
          log.info(
            { toolName: name, riskLevel },
            "Auto-approving for non-interactive guardian session",
          );
          return {
            allowed: true,
            decision: "guardian_auto_approve",
            riskLevel,
          };
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
            decision: "deny",
            reason: "Non-interactive session: no client to approve prompt",
            durationMs,
          });
          return {
            allowed: false,
            decision: "denied",
            riskLevel,
            content: `Permission denied: tool "${name}" requires user approval but no interactive client is connected. The tool was not executed. To allow this tool in non-interactive sessions, add a trust rule via permission settings.`,
          };
        }

        // Temporary approval override: if the guardian has enabled a
        // conversation-scoped "allow all" mode (allow_10m or allow_conversation),
        // skip the interactive prompt and auto-approve. Only applies to
        // guardian actors - untrusted actors cannot leverage this to bypass
        // guardian-required gates (those are enforced in pre-execution gates).
        // Exception: requireFreshApproval tools must always show the prompt -
        // cached temporary overrides cannot substitute for per-invocation
        // human review.
        if (
          context.trustClass === "guardian" &&
          getEffectiveMode(context.conversationId) !== undefined &&
          !context.requireFreshApproval
        ) {
          log.info(
            {
              toolName: name,
              riskLevel,
              conversationId: context.conversationId,
            },
            "Temporary approval override active - auto-approving without prompt",
          );
          return { allowed: true, decision: "temporary_override", riskLevel };
        }

        const allowlistOptions = await generateAllowlistOptions(
          name,
          input,
          context.signal,
        );
        const scopeOptions = generateScopeOptions(context.workingDir, name);
        const previewDiff = computePreviewDiff(name, input, context.workingDir);

        let sandboxed: boolean | undefined;
        if (name === "bash" && typeof input.command === "string") {
          const cfg = getConfig();
          const sandboxConfig =
            context.sandboxOverride != null
              ? { ...cfg.sandbox, enabled: context.sandboxOverride }
              : cfg.sandbox;
          const wrapped = wrapCommand(
            input.command,
            context.workingDir,
            sandboxConfig,
          );
          sandboxed = wrapped.sandboxed;
        }

        const persistentDecisionsAllowed = !context.requireFreshApproval;

        // Offer temporary approval options to guardians. Suppressed when
        // requireFreshApproval is true - temporary overrides would be
        // misleading since future invocations still require fresh approval.
        const temporaryOptionsAvailable:
          | Array<"allow_10m" | "allow_conversation">
          | undefined =
          context.trustClass === "guardian" && !context.requireFreshApproval
            ? ["allow_10m", "allow_conversation"]
            : undefined;

        emitLifecycleEvent({
          type: "permission_prompt",
          toolName: name,
          executionTarget,
          input,
          workingDir: context.workingDir,
          conversationId: context.conversationId,
          requestId: context.requestId,
          riskLevel,
          reason: result.reason,
          allowlistOptions,
          scopeOptions,
          diff: previewDiff,
          sandboxed,
          persistentDecisionsAllowed,
        });

        await getHookManager().trigger("permission-request", {
          toolName: name,
          input: sanitizeToolInput(name, input),
          riskLevel,
          conversationId: context.conversationId,
        });

        const response = await this.prompter.prompt(
          name,
          input,
          riskLevel,
          allowlistOptions,
          scopeOptions,
          previewDiff,
          sandboxed,
          context.conversationId,
          executionTarget,
          persistentDecisionsAllowed,
          context.signal,
          temporaryOptionsAvailable,
          context.toolUseId,
        );

        const decision = response.decision;

        await getHookManager().trigger("permission-resolve", {
          toolName: name,
          decision: response.decision,
          riskLevel,
          conversationId: context.conversationId,
        });

        if (response.decision === "deny") {
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
            decision: "deny",
            reason: denialReason,
            durationMs,
          });
          return {
            allowed: false,
            decision,
            riskLevel,
            content: denialMessage,
          };
        }

        if (response.decision === "always_deny") {
          // For non-scoped tools (empty scopeOptions), default to 'everywhere' since
          // the client has no scope picker and will send undefined.
          const effectiveDenyScope =
            scopeOptions.length === 0
              ? (response.selectedScope ?? "everywhere")
              : response.selectedScope;
          const ruleSaved = !!(
            persistentDecisionsAllowed &&
            response.selectedPattern &&
            effectiveDenyScope
          );
          if (ruleSaved) {
            addRule(
              name,
              response.selectedPattern!,
              effectiveDenyScope!,
              "deny",
            );
          }
          const denialReason = ruleSaved
            ? "Permission denied by user (rule saved)"
            : "Permission denied by user";
          const denialMessage = ruleSaved
            ? `Permission denied by user, and a rule was saved to always deny the "${name}" tool for this pattern. Do NOT retry this tool call. Inform the user that this action has been permanently blocked by their preference. If the user wants to allow it in the future, they can update their permission rules.`
            : `Permission denied by user. The user chose not to allow the "${name}" tool. Do NOT retry this tool call immediately. Instead, tell the user that the action was not performed because they denied permission, and ask if they would like you to try again or take a different approach. Wait for the user to explicitly respond before retrying.`;
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
            decision: "always_deny",
            reason: denialReason,
            durationMs,
          });
          return {
            allowed: false,
            decision,
            riskLevel,
            content: denialMessage,
          };
        }

        if (
          persistentDecisionsAllowed &&
          (response.decision === "always_allow" ||
            response.decision === "always_allow_high_risk") &&
          response.selectedPattern
        ) {
          const ruleOptions: {
            allowHighRisk?: boolean;
            executionTarget?: string;
          } = {};

          if (response.decision === "always_allow_high_risk") {
            ruleOptions.allowHighRisk = true;
          }

          if (policyContext?.executionTarget != null) {
            ruleOptions.executionTarget = policyContext.executionTarget;
          }

          const hasOptions = Object.keys(ruleOptions).length > 0;
          // Only default to 'everywhere' for non-scoped tools (empty scopeOptions).
          // For scoped tools, require an explicit scope to prevent silent permission widening.
          const effectiveScope =
            scopeOptions.length === 0
              ? (response.selectedScope ?? "everywhere")
              : response.selectedScope;
          if (effectiveScope) {
            addRule(
              name,
              response.selectedPattern,
              effectiveScope,
              "allow",
              100,
              hasOptions ? ruleOptions : undefined,
            );
          }
        }

        // Activate temporary approval mode when the user chooses a
        // time-limited or conversation-scoped override. Subsequent tool
        // invocations in this conversation will auto-approve without
        // prompting (checked above in the temporary override block).
        if (response.decision === "allow_10m") {
          setTimedMode(context.conversationId);
          log.info(
            { toolName: name, conversationId: context.conversationId },
            "Activated timed (10m) temporary approval mode",
          );
        } else if (response.decision === "allow_conversation") {
          setConversationMode(context.conversationId);
          log.info(
            { toolName: name, conversationId: context.conversationId },
            "Activated conversation-scoped temporary approval mode",
          );
        }

        return { allowed: true, decision, riskLevel };
      }

      // result.decision === 'allow'
      return { allowed: true, decision: "allow", riskLevel };
    } catch (err) {
      if (err instanceof Error) {
        (err as Error & { riskLevel?: string }).riskLevel = riskLevel;
      }
      throw err;
    }
  }
}
