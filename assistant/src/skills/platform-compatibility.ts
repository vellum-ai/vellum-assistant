import { assistantEventHub } from "../runtime/assistant-event-hub.js";

export const SKILL_PLATFORM_VALUES = ["macos", "windows", "linux"] as const;

export type SkillPlatform = (typeof SKILL_PLATFORM_VALUES)[number];

export interface PlatformScopedSkill {
  platforms?: readonly SkillPlatform[];
}

export interface SkillPlatformContext {
  clientOs?: unknown;
  isInteractive?: boolean;
  sourceActorPrincipalId?: string;
  /** Test seam for the actor-scoped connected host inventory. */
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

export function isSkillCompatibleWithContext(
  skill: PlatformScopedSkill,
  context: SkillPlatformContext,
): boolean {
  if (!skill.platforms || skill.platforms.length === 0) {
    return true;
  }
  if (
    context.isInteractive !== true ||
    context.sourceActorPrincipalId == null
  ) {
    return false;
  }
  const clientPlatform = skillPlatformForClientOs(context.clientOs);
  const capableHostPlatforms =
    context.hostPlatforms ??
    connectedHostPlatforms(context.sourceActorPrincipalId);
  return (
    clientPlatform !== null &&
    capableHostPlatforms.includes(clientPlatform) &&
    skill.platforms?.includes(clientPlatform) === true
  );
}

export function filterSkillsByContext<T extends PlatformScopedSkill>(
  skills: readonly T[],
  context: SkillPlatformContext,
): T[] {
  const capableHostPlatforms =
    context.hostPlatforms ??
    connectedHostPlatforms(context.sourceActorPrincipalId);
  return skills.filter((skill) =>
    isSkillCompatibleWithContext(skill, {
      ...context,
      hostPlatforms: capableHostPlatforms,
    }),
  );
}

export function skillPlatformUnavailableMessage(
  skillId: string,
  skill: PlatformScopedSkill,
): string {
  return `Skill "${skillId}" is unavailable on this operating system. Supported platforms: ${(skill.platforms ?? []).join(", ")}.`;
}
