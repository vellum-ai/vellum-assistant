/**
 * Skill category inference — ports the Swift `inferCategory` logic from
 * `ConstellationView.swift` to TypeScript for server-side use.
 *
 * Pure function with no side effects or external dependencies.
 */

export type SkillCategory =
  | "communication"
  | "productivity"
  | "development"
  | "media"
  | "automation"
  | "webSocial"
  | "knowledge"
  | "integration";

export const SKILL_CATEGORIES: SkillCategory[] = [
  "communication",
  "productivity",
  "development",
  "media",
  "automation",
  "webSocial",
  "knowledge",
  "integration",
];

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

export function inferCategory(
  name: string,
  description: string,
): SkillCategory {
  const combined = `${name} ${description}`.toLowerCase();

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        return category;
      }
    }
  }

  return "knowledge";
}
