import type { HostProxyCapability } from "../channels/types.js";
import {
  isSkillCompatibleWithContext as isHostSkillCompatibleWithContext,
  resolveSkillTurnIsInteractive as resolveHostSkillTurnIsInteractive,
  type SkillPlatform,
} from "../skills/platform-compatibility.js";

export type { HostProxyCapability, SkillPlatform };

export interface PlatformScopedSkill {
  platforms?: readonly SkillPlatform[];
  requiredHostCapabilities?: readonly HostProxyCapability[];
  unsupportedHostCapabilities?: readonly string[];
}

export interface SkillPlatformContext {
  clientOs?: unknown;
  isInteractive?: boolean;
  sourceActorPrincipalId?: string;
  hostPlatforms?: readonly unknown[];
}

export function isSkillCompatibleWithContext(
  skill: PlatformScopedSkill,
  context: SkillPlatformContext,
): boolean {
  return isHostSkillCompatibleWithContext(skill, context);
}

export function resolveSkillTurnIsInteractive(params: {
  isNonInteractive?: boolean;
  hasNoClient?: boolean;
}): boolean {
  return resolveHostSkillTurnIsInteractive(params);
}
