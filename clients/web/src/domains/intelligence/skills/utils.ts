import { type SkillFilter, type SkillInfo, isInstalledSkill } from "./types";

export function resolveFilterParams(filter: SkillFilter): {
  origin?: string;
  kind?: "installed" | "available";
} {
  switch (filter) {
    case "installed":
      return { kind: "installed" };
    case "available":
      return { kind: "available" };
    case "vellum":
    case "clawhub":
    case "skillssh":
    case "custom":
    case "assistant-memory":
      return { origin: filter };
    default:
      return {};
  }
}

export function sortSkills(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((a, b) => {
    const aInstalled = isInstalledSkill(a);
    const bInstalled = isInstalledSkill(b);
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
