import {
  BookOpen,
  Film,
  Globe,
  Link2,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  Wrench,
  Zap,
} from "lucide-react";

import type { SkillCategory } from "./types";

export const SKILL_CATEGORIES: SkillCategory[] = [
  "automation",
  "communication",
  "development",
  "integration",
  "knowledge",
  "media",
  "productivity",
  "webSocial",
];

export const CATEGORY_DISPLAY_NAMES: Record<SkillCategory, string> = {
  communication: "Communication",
  productivity: "Productivity",
  development: "Development",
  media: "Media",
  automation: "Automation",
  webSocial: "Web & Social",
  knowledge: "Knowledge",
  integration: "Integration",
};

export const CATEGORY_ICONS: Record<SkillCategory, LucideIcon> = {
  communication: MessageCircle,
  productivity: ListChecks,
  development: Wrench,
  media: Film,
  automation: Zap,
  webSocial: Globe,
  knowledge: BookOpen,
  integration: Link2,
};
