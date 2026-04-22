import { getConfig } from "../config/loader.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
import { isPermissionControlsV2Enabled } from "../permissions/v2-consent-policy.js";
import type { SecretPattern } from "../security/secret-scanner.js";
import {
  compileCustomPatterns,
  redactSecrets,
  scanText,
} from "../security/secret-scanner.js";
import type {
  ExecutionTarget,
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "./types.js";

/**
 * Encapsulates post-execution secret detection, redaction, and action handling.
 * Extracted from ToolExecutor to isolate the secret-scanning concern.
 */
export class SecretDetectionHandler {
  private prompter: PermissionPrompter;

  constructor(prompter: PermissionPrompter) {
    this.prompter = prompter;
  }

  /**
   * Scan a tool execution result for secrets and apply the configured action
   * (redact, block, or prompt). Returns the (possibly modified) result, or
   * a blocked result if secrets were blocked. Returns `null` when no secret
   * handling was needed and the caller should continue normally.
   */
  async handle(
    execResult: ToolExecutionResult,
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    decision: string,
    startTime: number,
    emitLifecycleEvent: (
      context: ToolContext,
      event: ToolLifecycleEvent,
    ) => void,
    sanitizeToolInput: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<{ result: ToolExecutionResult; earlyReturn: boolean }> {
    const sdConfig = getConfig().secretDetection;
    if (!sdConfig.enabled || execResult.isError) {
      return { result: execResult, earlyReturn: false };
    }

    const entropyConfig = {
      enabled: true,
      base64Threshold: sdConfig.entropyThreshold,
    };
    const compiledCustom = sdConfig.customPatterns?.length
      ? compileCustomPatterns(sdConfig.customPatterns)
      : undefined;

    const allMatches = this.collectMatches(
      execResult,
      entropyConfig,
      compiledCustom,
    );

    if (allMatches.length === 0) {
      return { result: execResult, earlyReturn: false };
    }

    const matchSummary = allMatches.map((m) => ({
      type: m.type,
      redactedValue: m.redactedValue,
    }));

    emitLifecycleEvent(context, {
      type: "secret_detected",
      toolName: name,
      executionTarget,
      input,
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      requestId: context.requestId,
      matches: matchSummary,
      action: sdConfig.action,
      detectedAtMs: Date.now(),
    });

    if (sdConfig.action === "redact") {
      this.redactResult(execResult, entropyConfig, compiledCustom);
      return { result: execResult, earlyReturn: false };
    }

    if (sdConfig.action === "block") {
      return this.handleBlock(
        allMatches,
        name,
        input,
        context,
        executionTarget,
        riskLevel,
        decision,
        startTime,
        emitLifecycleEvent,
        sanitizeToolInput,
      );
    }

    if (sdConfig.action === "prompt") {
      return this.handlePrompt(
        allMatches,
        execResult,
        name,
        input,
        context,
        executionTarget,
        riskLevel,
        decision,
        startTime,
        emitLifecycleEvent,
        sanitizeToolInput,
      );
    }

    return { result: execResult, earlyReturn: false };
  }

  private collectMatches(
    execResult: ToolExecutionResult,
    entropyConfig: { enabled: boolean; base64Threshold: number },
    compiledCustom: SecretPattern[] | undefined,
  ) {
    const contentMatches = scanText(
      execResult.content,
      entropyConfig,
      compiledCustom,
    );
    const diffMatches = execResult.diff
      ? scanText(execResult.diff.newContent, entropyConfig, compiledCustom)
      : [];
    const blockMatches = (execResult.contentBlocks ?? []).flatMap((block) => {
      if (block.type === "text")
        return scanText(block.text, entropyConfig, compiledCustom);
      if (block.type === "file" && block.extracted_text)
        return scanText(block.extracted_text, entropyConfig, compiledCustom);
      return [];
    });
    return [...contentMatches, ...diffMatches, ...blockMatches];
  }

  private redactResult(
    execResult: ToolExecutionResult,
    entropyConfig: { enabled: boolean; base64Threshold: number },
    compiledCustom: SecretPattern[] | undefined,
  ): void {
    execResult.content = redactSecrets(
      execResult.content,
      entropyConfig,
      compiledCustom,
    );
    if (execResult.diff) {
      execResult.diff = {
        ...execResult.diff,
        newContent: redactSecrets(
          execResult.diff.newContent,
          entropyConfig,
          compiledCustom,
        ),
      };
    }
    if (execResult.contentBlocks) {
      execResult.contentBlocks = execResult.contentBlocks.map((block) => {
        if (block.type === "text") {
          return {
            ...block,
            text: redactSecrets(block.text, entropyConfig, compiledCustom),
          };
        }
        if (block.type === "file" && block.extracted_text) {
          return {
            ...block,
            extracted_text: redactSecrets(
              block.extracted_text,
              entropyConfig,
              compiledCustom,
            ),
          };
        }
        return block;
      });
    }
  }

  private handleBlock(
    allMatches: Array<{ type: string; redactedValue: string }>,
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    decision: string,
    startTime: number,
    emitLifecycleEvent: (
      context: ToolContext,
      event: ToolLifecycleEvent,
    ) => void,
    _sanitizeToolInput: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): { result: ToolExecutionResult; earlyReturn: boolean } {
    const types = [...new Set(allMatches.map((m) => m.type))].join(", ");
    const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). Configure secretDetection.action to "redact" or "prompt" to allow output.`;
    const durationMs = Date.now() - startTime;
    const blockedResult: ToolExecutionResult = {
      content: blockedContent,
      isError: true,
    };

    emitLifecycleEvent(context, {
      type: "executed",
      toolName: name,
      executionTarget,
      input,
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      requestId: context.requestId,
      riskLevel,
      decision,
      durationMs,
      result: blockedResult,
    });

    return { result: blockedResult, earlyReturn: true };
  }

  private async handlePrompt(
    allMatches: Array<{ type: string; redactedValue: string }>,
    execResult: ToolExecutionResult,
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    executionTarget: ExecutionTarget,
    riskLevel: string,
    _decision: string,
    startTime: number,
    emitLifecycleEvent: (
      context: ToolContext,
      event: ToolLifecycleEvent,
    ) => void,
    _sanitizeToolInput: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<{ result: ToolExecutionResult; earlyReturn: boolean }> {
    const types = [...new Set(allMatches.map((m) => m.type))].join(", ");

    if (isPermissionControlsV2Enabled()) {
      const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). Secret-output approval cards are disabled under v2. Ask the user for confirmation conversationally before retrying.`;
      const durationMs = Date.now() - startTime;

      emitLifecycleEvent(context, {
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel: RiskLevel.High,
        decision: "deny",
        reason: "Secret output blocked without deterministic prompt under v2",
        durationMs,
      });

      return {
        result: { content: blockedContent, isError: true },
        earlyReturn: true,
      };
    }

    // Non-interactive sessions: auto-block secret output instead of waiting for prompt
    if (context.isInteractive === false) {
      const blockedContent = `Tool output blocked: detected ${allMatches.length} potential secret(s) (${types}). No interactive client available to approve.`;
      const durationMs = Date.now() - startTime;

      emitLifecycleEvent(context, {
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel: RiskLevel.High,
        decision: "deny",
        reason: "Non-interactive session: auto-blocked secret output",
        durationMs,
      });

      return {
        result: { content: blockedContent, isError: true },
        earlyReturn: true,
      };
    }

    const promptInput = {
      _secretDetection: true,
      summary: `Tool output contains ${allMatches.length} potential secret(s): ${types}`,
      tool: name,
    };

    emitLifecycleEvent(context, {
      type: "permission_prompt",
      toolName: name,
      executionTarget,
      input: promptInput,
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      requestId: context.requestId,
      riskLevel: RiskLevel.High,
      reason: `Secret detected in tool output: ${types}`,
      allowlistOptions: [],
      scopeOptions: [],
      persistentDecisionsAllowed: false,
    });

    const response = await this.prompter.prompt(
      name,
      promptInput,
      RiskLevel.High,
      [], // no allowlist options
      [], // no scope options
      undefined, // no diff
      context.conversationId,
      executionTarget,
      false, // no persistent decisions
      context.signal,
    );

    if (response.decision === "deny" || response.decision === "always_deny") {
      const blockedContent = `Tool output blocked: user denied output containing ${allMatches.length} potential secret(s) (${types}).`;
      const durationMs = Date.now() - startTime;

      emitLifecycleEvent(context, {
        type: "permission_denied",
        toolName: name,
        executionTarget,
        input,
        workingDir: context.workingDir,
        conversationId: context.conversationId,
        requestId: context.requestId,
        riskLevel: RiskLevel.High,
        decision: response.decision === "always_deny" ? "always_deny" : "deny",
        reason: `User denied output containing secrets: ${types}`,
        durationMs,
      });

      return {
        result: { content: blockedContent, isError: true },
        earlyReturn: true,
      };
    }

    // User allowed - pass content through unchanged
    return { result: execResult, earlyReturn: false };
  }
}
