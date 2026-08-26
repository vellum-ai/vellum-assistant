import {
  HOST_PROXY_CAPABILITIES,
  type HostProxyCapability,
} from "../channels/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";

export const SKILL_PLATFORM_VALUES = ["macos", "windows", "linux"] as const;
export const INVALID_REQUIRED_HOST_CAPABILITIES =
  "<invalid-required-host-capabilities>";

export type SkillPlatform = (typeof SKILL_PLATFORM_VALUES)[number];

export interface PlatformScopedSkill {
  platforms?: readonly SkillPlatform[];
  requiredHostCapabilities?: readonly HostProxyCapability[];
  unsupportedHostCapabilities?: readonly string[];
}

export interface HostPlatformCapabilityProof {
  platform: SkillPlatform;
  capabilities: readonly HostProxyCapability[];
}

export interface SkillPlatformContext {
  clientOs?: unknown;
  isInteractive?: boolean;
  sourceActorPrincipalId?: string;
  /** Test seams for platform and connected host inventory. */
  daemonPlatform?: NodeJS.Platform;
  hostPlatforms?: readonly unknown[];
}

export function resolveSkillTurnIsInteractive(params: {
  isNonInteractive?: boolean;
  hasNoClient?: boolean;
}): boolean {
  if (params.isNonInteractive !== undefined) {
    return !params.isNonInteractive;
  }
  return params.hasNoClient === false;
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

export function normalizeRequiredHostCapabilities(value: unknown): {
  requiredHostCapabilities?: HostProxyCapability[];
  unsupportedHostCapabilities?: string[];
} {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    return {
      unsupportedHostCapabilities: [INVALID_REQUIRED_HOST_CAPABILITIES],
    };
  }
  const hasMalformedEntry = value.some(
    (capability) =>
      typeof capability !== "string" || capability.trim().length === 0,
  );
  const declared = [
    ...new Set(
      value
        .filter(
          (capability): capability is string => typeof capability === "string",
        )
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
    ),
  ];
  const requiredHostCapabilities = declared.filter(
    (capability): capability is HostProxyCapability =>
      (HOST_PROXY_CAPABILITIES as readonly string[]).includes(capability),
  );
  const unsupportedHostCapabilities = declared.filter(
    (capability) =>
      !(HOST_PROXY_CAPABILITIES as readonly string[]).includes(capability),
  );
  if (hasMalformedEntry) {
    unsupportedHostCapabilities.push(INVALID_REQUIRED_HOST_CAPABILITIES);
  }
  return {
    ...(requiredHostCapabilities.length > 0
      ? { requiredHostCapabilities }
      : {}),
    ...(unsupportedHostCapabilities.length > 0
      ? { unsupportedHostCapabilities }
      : {}),
  };
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

interface CapableHostInventory {
  hasCapableHost: boolean;
  platforms: SkillPlatform[];
}

function connectedHostInventory(
  sourceActorPrincipalId: string | undefined,
  requiredCapabilities: readonly HostProxyCapability[],
): CapableHostInventory {
  if (sourceActorPrincipalId == null) {
    return { hasCapableHost: false, platforms: [] };
  }
  const capableClients = assistantEventHub
    .listClients()
    .filter((client) => client.actorPrincipalId === sourceActorPrincipalId)
    .filter((client) =>
      requiredCapabilities.every((capability) =>
        client.capabilities.includes(capability),
      ),
    );
  const platforms = capableClients
    .map((client) => skillPlatformForClientOs(client.interfaceId))
    .filter((platform): platform is SkillPlatform => platform !== null);
  return {
    hasCapableHost: capableClients.length > 0,
    platforms: [...new Set(platforms)],
  };
}

function provenHostInventory(
  values: readonly unknown[],
  requiredCapabilities: readonly HostProxyCapability[],
): CapableHostInventory {
  const platforms: SkillPlatform[] = [];
  let hasCapableHost = false;
  for (const value of values) {
    if (typeof value === "string") {
      const platform = skillPlatformForClientOs(value);
      if (platform) {
        hasCapableHost = true;
        platforms.push(platform);
      }
      continue;
    }
    if (value == null || typeof value !== "object") {
      continue;
    }
    const proof = value as Partial<HostPlatformCapabilityProof>;
    const capabilities = proof.capabilities;
    if (
      !Array.isArray(capabilities) ||
      !requiredCapabilities.every((capability) =>
        capabilities.includes(capability),
      )
    ) {
      continue;
    }
    hasCapableHost = true;
    const platform = skillPlatformForClientOs(proof.platform);
    if (platform) {
      platforms.push(platform);
    }
  }
  return { hasCapableHost, platforms: [...new Set(platforms)] };
}

export function isSkillCompatibleWithContext(
  skill: PlatformScopedSkill,
  context: SkillPlatformContext,
): boolean {
  return skillCompatibilityIssue(skill, context) === null;
}

type SkillCompatibilityIssue =
  | "unsupported-capabilities"
  | "interactive-turn-required"
  | "actor-required"
  | "host-capabilities-required"
  | "platform";

function skillCompatibilityIssue(
  skill: PlatformScopedSkill,
  context: SkillPlatformContext,
): SkillCompatibilityIssue | null {
  if ((skill.unsupportedHostCapabilities?.length ?? 0) > 0) {
    return "unsupported-capabilities";
  }
  const requiredCapabilities = skill.requiredHostCapabilities ?? [];
  if (requiredCapabilities.length > 0) {
    if (context.isInteractive !== true) {
      return "interactive-turn-required";
    }
    if (context.sourceActorPrincipalId == null) {
      return "actor-required";
    }
    const capableHosts = context.hostPlatforms
      ? provenHostInventory(context.hostPlatforms, requiredCapabilities)
      : connectedHostInventory(
          context.sourceActorPrincipalId,
          requiredCapabilities,
        );
    if (!capableHosts.hasCapableHost) {
      return "host-capabilities-required";
    }
    const skillPlatforms = skill.platforms;
    if (!skillPlatforms || skillPlatforms.length === 0) {
      return null;
    }
    return capableHosts.platforms.some((platform) =>
      skillPlatforms.includes(platform),
    )
      ? null
      : "platform";
  }
  if (!skill.platforms || skill.platforms.length === 0) {
    return null;
  }
  const daemonPlatform = skillPlatformForNodePlatform(
    context.daemonPlatform ?? process.platform,
  );
  return daemonPlatform !== null && skill.platforms.includes(daemonPlatform)
    ? null
    : "platform";
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
  context: SkillPlatformContext = {},
): string {
  const issue = skillCompatibilityIssue(skill, context);
  const requiredCapabilities = skill.requiredHostCapabilities ?? [];
  const capabilities = requiredCapabilities.join(", ");
  if (issue === "unsupported-capabilities") {
    return `Skill "${skillId}" has unsupported host capability requirements.`;
  }
  if (issue === "interactive-turn-required") {
    return `Skill "${skillId}" requires an interactive turn and a connected host that provides: ${capabilities}.`;
  }
  if (issue === "actor-required") {
    return `Skill "${skillId}" requires an authenticated user and a connected host that provides: ${capabilities}.`;
  }
  if (issue === "host-capabilities-required") {
    return `Skill "${skillId}" requires a connected host that provides: ${capabilities}. Reconnect a compatible host client and try again.`;
  }
  return `Skill "${skillId}" is unavailable on this operating system. Supported platforms: ${(skill.platforms ?? []).join(", ")}.`;
}
