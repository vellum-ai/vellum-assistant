import type { SkillOrigin } from "@/domains/intelligence/skills/types";

/**
 * One filter axis for the merged My Superpowers list. Three groups share it:
 * status (`all` / `installed` / `available`, applies to skills and plugins
 * alike), type (`skills` / `plugins`, narrows the list to one kind), and
 * source (the skill origins — skills-only, so plugins are hidden while one
 * is active).
 */
export type SuperpowerFilter =
  | "all"
  | "installed"
  | "available"
  | "skills"
  | "plugins"
  | SkillOrigin;
