import {
  HOST_PROXY_CAPABILITIES,
  type HostProxyCapability,
} from "../channels/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";

export const SKILL_PLATFORM_VALUES = ["macos", "windows", "linux"] as const;

export type SkillPlatform = (typeof SKILL_PLATFORM_VALUES)[number];

export interface PlatformScopedSkill {
  platforms?: readonly SkillPlatform[];
  requiredHostCapabilities?: readonly HostProxyCapability[];
}

export interface SkillPlatformContext {
  clientOs?: unknown;
  isInteractive?: boolean;
  sourceActorPrincipalId?: string;
  /** Test seams for platform and connected host inventory. */
  daemonPlatform?: NodeJS.Platform;
  hostPlatforms?: readonly unknown[];
}

export function normalizeSkillPlatforms(
  value: unknown,
): SkillPlatform[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const platforms = [
    ...new Set(
      value.filter((platform): platform is SkillPlatform =>
        (SKILL_PLATFORM_VALUES as readonly unknown[]).includes(platform),
      ),
    ),
  ];
  return platforms.length > 0 ? platforms : undefined;
}

export function normalizeRequiredHostCapabilities(
  value: unknown,
): HostProxyCapability[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const capabilities = [
    ...new Set(
      value.filter((capability): capability is HostProxyCapability =>
        (HOST_PROXY_CAPABILITIES as readonly unknown[]).includes(capability),
      ),
    ),
  ];
  return capabilities.length > 0 ? capabilities : undefined;
}

export function skillPlatformForNodePlatform(
  platform: NodeJS.Platform,
): SkillPlatform | null {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "linux") {
    return "linux";
  }
  return null;
}

export function skillPlatformForClientOs(value: unknown): SkillPlatform | null {
  return typeof value === "string" &&
    (SKILL_PLATFORM_VALUES as readonly string[]).includes(value)
    ? (value as SkillPlatform)
    : null;
}

function connectedHostPlatforms(
  sourceActorPrincipalId: string | undefined,
  requiredCapabilities: readonly HostProxyCapability[],
): SkillPlatform[] {
  if (sourceActorPrincipalId == null) {
    return [];
  }
  const platforms = assistantEventHub
    .listClients()
    .filter((client) => client.actorPrincipalId === sourceActorPrincipalId)
    .filter((client) =>
      requiredCapabilities.every((capability) =>
        client.capabilities.includes(capability),
      ),
    )
    .map((client) => skillPlatformForClientOs(client.interfaceId))
    .filter((platform): platform is SkillPlatform => platform !== null);
  return [...new Set(platforms)];
}

export function isSkillCompatibleWithContext(
  skill: PlatformScopedSkill,
  context: SkillPlatformContext,
): boolean {
  const requiredCapabilities = skill.requiredHostCapabilities ?? [];
  if (requiredCapabilities.length > 0) {
    if (
      context.isInteractive !== true ||
      context.sourceActorPrincipalId == null
    ) {
      return false;
    }
    const capableHostPlatforms = (
      context.hostPlatforms ??
      connectedHostPlatforms(
        context.sourceActorPrincipalId,
        requiredCapabilities,
      )
    )
      .map(skillPlatformForClientOs)
      .filter((platform): platform is SkillPlatform => platform !== null);
    return capableHostPlatforms.some(
      (platform) => !skill.platforms || skill.platforms.includes(platform),
    );
  }
  if (!skill.platforms || skill.platforms.length === 0) {
    return true;
  }
  const daemonPlatform = skillPlatformForNodePlatform(
    context.daemonPlatform ?? process.platform,
  );
  return daemonPlatform !== null && skill.platforms.includes(daemonPlatform);
}

export function filterSkillsByContext<T extends PlatformScopedSkill>(
  skills: readonly T[],
  context: SkillPlatformContext,
): T[] {
  return skills.filter((skill) => isSkillCompatibleWithContext(skill, context));
}

export function skillPlatformUnavailableMessage(
  skillId: string,
  skill: PlatformScopedSkill,
): string {
  return `Skill "${skillId}" is unavailable on this operating system. Supported platforms: ${(skill.platforms ?? []).join(", ")}.`;
}
