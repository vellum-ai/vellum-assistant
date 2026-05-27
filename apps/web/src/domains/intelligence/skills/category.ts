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

import type { SkillCategory, SkillInfo } from "./types";

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

const CATEGORY_KEYWORDS: [SkillCategory, string[]][] = [
  [
    "communication",
    [
      "email",
      "message",
      "messaging",
      "chat",
      "phone",
      "phone call",
      "voice call",
      "video call",
      "contact",
      "notification",
      "followup",
      "slack",
      "telegram",
    ],
  ],
  [
    "productivity",
    [
      "task",
      "calendar",
      "reminder",
      "schedule",
      "document",
      "playbook",
      "notion",
    ],
  ],
  [
    "development",
    [
      "code",
      "app builder",
      "github",
      "developer",
      "programming",
      "debug",
      "typescript",
      "frontend",
      "subagent",
      "api mapping",
      "cli discovery",
    ],
  ],
  ["automation", ["browser", "computer use", "macos", "watcher", "automat"]],
  [
    "media",
    ["image", "screen", "media", "transcri", "video", "audio", "recording"],
  ],
  [
    "webSocial",
    [
      "x.com",
      "twitter",
      "public ingress",
      "influencer",
      "doordash",
      "amazon",
      "restaurant",
    ],
  ],
  [
    "knowledge",
    [
      "knowledge",
      "weather",
      "start the day",
      "skills catalog",
      "self upgrade",
      "briefing",
    ],
  ],
  ["integration", ["oauth", "setup", "configure", "connect", "webhook"]],
];

export function inferCategory(skill: Pick<SkillInfo, "name" | "description">): SkillCategory {
  const combined = `${skill.name} ${skill.description}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        return category;
      }
    }
  }
  return "knowledge";
}
