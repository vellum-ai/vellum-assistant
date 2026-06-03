export type SkillCategory =
  | "email"
  | "calendar"
  | "messaging"
  | "browsing"
  | "productivity"
  | "development"
  | "voice"
  | "commerce"
  | "content"
  | "health"
  | "system"
  | "integrations";

const CATEGORY_KEYWORDS: [SkillCategory, string[]][] = [
  [
    "email",
    ["email", "inbox", "mail", "mailgun", "resend", "agentmail"],
  ],
  [
    "calendar",
    ["calendar", "schedule", "meeting", "google calendar", "outlook calendar"],
  ],
  [
    "messaging",
    [
      "message",
      "messaging",
      "chat",
      "slack",
      "telegram",
      "discord",
      "notification",
      "phone",
      "phone call",
      "voice call",
      "video call",
      "contact",
      "followup",
    ],
  ],
  [
    "browsing",
    ["browser", "computer use", "browse", "web page", "scrape"],
  ],
  [
    "productivity",
    ["task", "reminder", "document", "playbook", "notion", "linear"],
  ],
  [
    "development",
    [
      "code",
      "github",
      "developer",
      "programming",
      "debug",
      "typescript",
      "frontend",
      "subagent",
      "api mapping",
      "cli discovery",
      "app builder",
    ],
  ],
  [
    "voice",
    ["voice", "tts", "speech", "audio", "elevenlabs", "fish audio", "transcri"],
  ],
  [
    "commerce",
    [
      "amazon",
      "doordash",
      "stripe",
      "restaurant",
      "shopping",
      "payment",
      "order",
    ],
  ],
  [
    "content",
    [
      "image",
      "screen",
      "media",
      "video",
      "recording",
      "meme",
      "influencer",
      "x.com",
      "twitter",
      "social",
    ],
  ],
  ["health", ["health", "oura", "fitness", "wellness"]],
  [
    "system",
    [
      "self upgrade",
      "heartbeat",
      "memory",
      "migration",
      "terminal",
      "watcher",
      "macos",
      "automat",
      "skills catalog",
      "start the day",
      "weather",
      "knowledge",
      "briefing",
    ],
  ],
  [
    "integrations",
    [
      "oauth",
      "setup",
      "configure",
      "connect",
      "webhook",
      "sentry",
      "github app",
    ],
  ],
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

  return "system";
}
