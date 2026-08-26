import { assistantEventHub } from "../runtime/assistant-event-hub.js";

export const SKILL_PLATFORM_VALUES = ["macos", "windows", "linux"] as const;

export type SkillPlatform = (typeof SKILL_PLATFORM_VALUES)[number];

export interface PlatformScopedSkill {
  platforms?: readonly SkillPlatform[];
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
): SkillPlatform[] {
  if (sourceActorPrincipalId == null) {
    return [];
  }
  const platforms = assistantEventHub
    .listClientsByCapability("host_bash")
    .filter((client) => client.actorPrincipalId === sourceActorPrincipalId)
    .map((client) => skillPlatformForClientOs(client.interfaceId))
    .filter((platform): platform is SkillPlatform => platform !== null);
  return [...new Set(platforms)];
}

export function isSkillCompatibleWithPlatform(
  skill: PlatformScopedSkill,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!skill.platforms || skill.platforms.length === 0) {
    return true;
  }
  const skillPlatform = skillPlatformForNodePlatform(platform);
  return skillPlatform !== null && skill.platforms.includes(skillPlatform);
}

export function isSkillCompatibleWithClientPlatform(
  skill: PlatformScopedSkill,
  clientOs: unknown,
  platform: NodeJS.Platform = process.platform,
  hostPlatforms?: readonly unknown[],
  sourceActorPrincipalId?: string,
): boolean {
  if (!skill.platforms || skill.platforms.length === 0) {
    return true;
  }
  if (clientOs == null) {
    return isSkillCompatibleWithPlatform(skill, platform);
  }
  const clientPlatform = skillPlatformForClientOs(clientOs);
  const capableHostPlatforms =
    hostPlatforms ?? connectedHostPlatforms(sourceActorPrincipalId);
  return (
    clientPlatform !== null &&
    capableHostPlatforms.includes(clientPlatform) &&
    skill.platforms?.includes(clientPlatform) === true
  );
}

export function filterSkillsByPlatform<T extends PlatformScopedSkill>(
  skills: readonly T[],
  platform: NodeJS.Platform = process.platform,
): T[] {
  return skills.filter((skill) =>
    isSkillCompatibleWithPlatform(skill, platform),
  );
}

export function filterSkillsByClientPlatform<T extends PlatformScopedSkill>(
  skills: readonly T[],
  clientOs: unknown,
  platform: NodeJS.Platform = process.platform,
  hostPlatforms?: readonly unknown[],
  sourceActorPrincipalId?: string,
): T[] {
  const capableHostPlatforms =
    hostPlatforms ?? connectedHostPlatforms(sourceActorPrincipalId);
  return skills.filter((skill) =>
    isSkillCompatibleWithClientPlatform(
      skill,
      clientOs,
      platform,
      capableHostPlatforms,
      sourceActorPrincipalId,
    ),
  );
}

export function skillPlatformUnavailableMessage(
  skillId: string,
  skill: PlatformScopedSkill,
): string {
  return `Skill "${skillId}" is unavailable on this operating system. Supported platforms: ${(skill.platforms ?? []).join(", ")}.`;
}
