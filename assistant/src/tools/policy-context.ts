import { getConfig } from "../config/loader.js";
import { isV3TierActive } from "../config/memory-v3-gate.js";
import type { ExecutionContext } from "../permissions/approval-policy.js";
import type { ChannelPermissionCoordinates } from "../permissions/channel-permission-query.js";
import type { PolicyContext } from "../permissions/types.js";
import { getToolOwner } from "./registry.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Channel coordinates of the turn, in {@link PolicyContext} shape. The
 * permission checker reaches these through the policy context, while the
 * sensitive-tool gate runs before one exists and reads a `ToolContext`
 * directly — both resolve the same permission-matrix cell, so the field
 * mapping lives here once rather than in each lane.
 */
export function channelCoordinatesFromToolContext(
  context?: ToolContext,
): ChannelPermissionCoordinates {
  return {
    trustClass: context?.trustClass,
    sourceChannel: context?.executionChannel,
    channelExternalId: context?.channelPermissionChannelId,
    channelConversationType: context?.channelConversationType,
  };
}

/**
 * Derive the execution context from the tool context fields.
 * - Guardian + non-interactive → "background" (scheduled jobs, reminders)
 * - Non-interactive (non-guardian) → "headless"
 * - Otherwise → "conversation"
 */
function deriveExecutionContext(context?: ToolContext): ExecutionContext {
  if (context?.isInteractive === false && context.trustClass === "guardian") {
    return "background";
  }
  if (context?.isInteractive === false) {
    return "headless";
  }
  return "conversation";
}

/**
 * Build a PolicyContext from tool metadata and execution context.
 * When executing within a task run, ephemeral permission rules are
 * included so pre-approved tools are auto-allowed without prompting.
 */
export function buildPolicyContext(
  tool: Tool,
  context?: ToolContext,
): PolicyContext {
  const executionContext = deriveExecutionContext(context);

  const conversationId = context?.conversationId;

  // Origin/trust/channel signals the checker uses to scope narrow
  // non-interactive auto-grants (e.g. the memory-retrospective skill-authoring
  // grant) to a specific internal origin. Background-job turns populate
  // `requestOrigin`; `trustClass`/`executionChannel` come from the turn's
  // resolved trust context. Undefined for normal interactive turns, so no
  // origin-scoped grant can fire for them.
  const originSignals = {
    requestOrigin: context?.requestOrigin,
    ...channelCoordinatesFromToolContext(context),
    requesterContactId: context?.requesterContactId,
    // Precompute the proc-to-skills gate — the v3 tier being active, i.e.
    // memory on AND v3 live — here so the permission checker, a leaf module
    // that must not read config, can deny the memory-retrospective
    // skill-authoring grant whenever the feature is inactive just by reading
    // this boolean.
    procToSkillsActive: isV3TierActive(getConfig()),
  };

  const ownerKind = getToolOwner(tool.name)?.kind;
  if (ownerKind === "skill" || ownerKind === "plugin") {
    return {
      executionTarget: tool.executionTarget,
      executionContext,
      conversationId,
      ...originSignals,
    };
  }

  return {
    executionContext,
    conversationId,
    ...originSignals,
  };
}
