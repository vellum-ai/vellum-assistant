import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { DiskPressureStatus } from "./disk-pressure-guard.js";
import type { ConversationType } from "./message-types/shared.js";
import type { TrustContext } from "./trust-context.js";

export type DiskPressureCleanupReason = "local-owner" | "guardian";

export type DiskPressureBlockReason =
  | "background"
  | "trusted-contact"
  | "non-guardian"
  | "unknown-remote";

export type DiskPressureTurnPolicyDecision =
  | { action: "allow-normal" }
  | { action: "allow-cleanup-mode"; reason: DiskPressureCleanupReason }
  | { action: "block"; reason: DiskPressureBlockReason };

export type DiskPressureTurnTrustClass =
  | TrustContext["trustClass"]
  | "non_guardian"
  | "non-guardian"
  | (string & {});

export interface DiskPressureTurnTrustContext {
  sourceChannel?: TrustContext["sourceChannel"] | (string & {});
  trustClass?: DiskPressureTurnTrustClass;
}

export interface DiskPressureTurnMetadata {
  conversationType?: ConversationType | (string & {}) | null;
  conversationGroupId?: string | null;
  conversationSource?: string | null;
  callSite?: LLMCallSite | (string & {}) | null;
  isInteractive?: boolean | null;
  sourceChannel?: TrustContext["sourceChannel"] | (string & {}) | null;
  sourceInterface?: InterfaceId | "vellum" | (string & {}) | null;
  trustContext?: DiskPressureTurnTrustContext | null;
  isDirectWake?: boolean | null;
}

const BACKGROUND_CONVERSATION_TYPES = new Set(["background", "scheduled"]);
const BACKGROUND_GROUP_IDS = new Set(["system:background", "system:scheduled"]);
const BACKGROUND_SOURCES = new Set([
  "auto-analysis",
  "background",
  "compaction",
  "direct",
  "filing",
  "heartbeat",
  "memory",
  "notification",
  "proactive-artifact",
  "reminder",
  "schedule",
  "task",
  "update-bulletin",
]);
const LOCAL_OWNER_INTERFACES = new Set(["macos", "web", "vellum", "cli"]);

export function classifyDiskPressureTurnPolicy(
  status: DiskPressureStatus,
  metadata: DiskPressureTurnMetadata,
): DiskPressureTurnPolicyDecision {
  if (!status.enabled || !status.locked || status.overrideActive) {
    return { action: "allow-normal" };
  }

  if (!status.effectivelyLocked) {
    return { action: "allow-normal" };
  }

  if (isBackgroundTurn(metadata)) {
    return { action: "block", reason: "background" };
  }

  const trustClass = metadata.trustContext?.trustClass;
  if (trustClass === "guardian") {
    return { action: "allow-cleanup-mode", reason: "guardian" };
  }

  if (trustClass === "trusted_contact") {
    return { action: "block", reason: "trusted-contact" };
  }

  if (isNonGuardianTrustClass(trustClass)) {
    return { action: "block", reason: "non-guardian" };
  }

  if (trustClass === "unknown") {
    return { action: "block", reason: "unknown-remote" };
  }

  if (trustClass !== undefined) {
    return { action: "block", reason: "non-guardian" };
  }

  if (isLocalOwnerTurnWithoutTrust(metadata)) {
    return { action: "allow-cleanup-mode", reason: "local-owner" };
  }

  return { action: "block", reason: "unknown-remote" };
}

function isBackgroundTurn(metadata: DiskPressureTurnMetadata): boolean {
  if (isExplicitLocalOwnerCleanupTurn(metadata)) return false;
  if (metadata.isDirectWake) return true;
  if (metadata.callSite != null && metadata.callSite !== "mainAgent") {
    return true;
  }
  if (
    metadata.conversationType != null &&
    BACKGROUND_CONVERSATION_TYPES.has(metadata.conversationType)
  ) {
    return true;
  }
  if (
    metadata.conversationGroupId != null &&
    BACKGROUND_GROUP_IDS.has(metadata.conversationGroupId)
  ) {
    return true;
  }
  return (
    metadata.conversationSource != null &&
    BACKGROUND_SOURCES.has(metadata.conversationSource)
  );
}

function isNonGuardianTrustClass(
  trustClass: DiskPressureTurnTrustClass | undefined,
): boolean {
  return trustClass === "non_guardian" || trustClass === "non-guardian";
}

function isLocalOwnerTurnWithoutTrust(
  metadata: DiskPressureTurnMetadata,
): boolean {
  if (metadata.trustContext != null) return false;

  const channel = metadata.sourceChannel;
  const sourceInterface = metadata.sourceInterface;
  if (channel !== "vellum" || sourceInterface == null) return false;
  return LOCAL_OWNER_INTERFACES.has(sourceInterface);
}

function isExplicitLocalOwnerCleanupTurn(
  metadata: DiskPressureTurnMetadata,
): boolean {
  if (metadata.isDirectWake !== true) return false;
  const sourceInterface = metadata.sourceInterface;
  if (
    metadata.sourceChannel !== "vellum" ||
    sourceInterface == null ||
    !LOCAL_OWNER_INTERFACES.has(sourceInterface)
  ) {
    return false;
  }
  return (
    metadata.trustContext == null ||
    metadata.trustContext.trustClass === "guardian"
  );
}
