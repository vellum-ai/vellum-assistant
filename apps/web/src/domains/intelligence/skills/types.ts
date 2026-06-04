import type {
  SkillsByIdFilesGetResponse,
  SkillsGetResponses,
} from "@/generated/daemon/types.gen";

export type SkillOrigin = "vellum" | "clawhub" | "skillssh" | "custom";

export type SkillKind = "bundled" | "installed" | "catalog";

export type SkillStatus = "enabled" | "disabled" | "available";

export type SkillCategory = string;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
  emoji?: string;
  kind: SkillKind;
  status: SkillStatus;
  origin: SkillOrigin;
  category: SkillCategory;
  slug?: string;
  author?: string;
  stars?: number;
  installs?: number;
  reports?: number;
  publishedAt?: string;
  version?: string;
  sourceRepo?: string;
}

/**
 * The skill type as generated from the daemon OpenAPI spec — a discriminated
 * union by `origin`. Each variant carries origin-specific fields (e.g.
 * clawhub has `author`, skillssh has `sourceRepo`).
 */
type GeneratedSkill = SkillsGetResponses[200]["skills"][number];

/**
 * Compile-time guard: every variant of the generated discriminated union
 * must be assignable to `SkillInfo`. If the daemon OpenAPI spec renames a
 * field or adds a variant that breaks the shape, this line produces a type
 * error — surfacing the drift immediately instead of silently at runtime.
 *
 * @see https://www.typescriptlang.org/docs/handbook/2/generics.html#generic-constraints
 */
type AssertAssignable<_Target, _Source extends _Target> = true;
type _SkillInfoCompat = AssertAssignable<SkillInfo, GeneratedSkill>;

export type SkillFileEntry = SkillsByIdFilesGetResponse["files"][number];

export type SkillFilter = "all" | "installed" | "available" | SkillOrigin;

export function isInstalledSkill(skill: SkillInfo): boolean {
  return skill.kind === "installed" || skill.kind === "bundled";
}

export function isAvailableSkill(skill: SkillInfo): boolean {
  return skill.kind === "catalog";
}

export function isRemovableSkill(skill: SkillInfo): boolean {
  return skill.kind === "installed";
}
