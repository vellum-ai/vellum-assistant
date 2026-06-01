export type SkillOrigin = "vellum" | "clawhub" | "skillssh" | "custom";

export type SkillKind = "bundled" | "installed" | "catalog";

export type SkillStatus = "enabled" | "disabled" | "available";

export type SkillCategory =
  | "communication"
  | "productivity"
  | "development"
  | "media"
  | "automation"
  | "webSocial"
  | "knowledge"
  | "integration";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
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

export interface SkillFileEntry {
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
  isBinary?: boolean;
  content?: string | null;
}

export interface SkillFilesResponse {
  id: string;
  name: string;
  description?: string;
  files: SkillFileEntry[];
}

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
