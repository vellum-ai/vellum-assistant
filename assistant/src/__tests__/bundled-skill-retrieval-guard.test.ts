import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const ASSISTANT_DIR = join(import.meta.dir, "..", "..");
const BUNDLED_SKILLS_DIR = join(
  ASSISTANT_DIR,
  "src",
  "config",
  "bundled-skills",
);

function collectSkillFiles(rootDir: string): string[] {
  const pending = [rootDir];
  const files: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

const ALL_SKILL_FILES = collectSkillFiles(BUNDLED_SKILLS_DIR);

const GATEWAY_RETRIEVAL_BANLIST: Array<{
  skillPath: string;
  bannedSnippets: string[];
}> = [
  {
    skillPath: "guardian-verify-setup/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/channel-verification-sessions/status',
    ],
  },
  {
    skillPath: "telegram-setup/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/telegram/config',
    ],
  },
  {
    skillPath: "contacts/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members',
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites',
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/contacts/invites',
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/telegram/config',
    ],
  },
  {
    skillPath: "twilio-setup/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/config"',
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/numbers"',
    ],
  },
  {
    skillPath: "phone-calls/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/twilio/config"',
    ],
  },
  {
    skillPath: "public-ingress/SKILL.md",
    bannedSnippets: [
      'curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/',
      "security find-generic-password",
      "secret-tool lookup service vellum-assistant account credential:ngrok:authtoken",
    ],
  },
  {
    skillPath: "voice-setup/SKILL.md",
    bannedSnippets: [
      "assistant config get elevenlabs.voiceId",
      "assistant config get calls.enabled",
    ],
  },
  {
    skillPath: "email-setup/SKILL.md",
    bannedSnippets: [
      "host_bash",
      "assistant email create",
      "assistant config set email.address",
    ],
  },
];

const KEYCHAIN_ALLOWLIST = new Set<string>([
  // Keep empty unless a keychain lookup instruction is intentionally required.
]);

const KEYCHAIN_PATTERNS = [
  "security find-generic-password",
  "secret-tool lookup service vellum-assistant account credential:",
];

const HOST_BASH_RETRIEVAL_ALLOWLIST = new Set<string>([
  // Keep empty unless a host-only retrieval command is intentionally required.
]);

const RETRIEVAL_MARKERS = [
  "assistant config get",
  "assistant email status",
  "assistant email inbox list",
  "assistant email provider get",
];

describe("bundled skill retrieval guard", () => {
  test("migrated skills do not reintroduce direct gateway/keychain retrieval snippets", () => {
    const violations: string[] = [];

    for (const rule of GATEWAY_RETRIEVAL_BANLIST) {
      const abs = join(BUNDLED_SKILLS_DIR, rule.skillPath);
      const content = readFileSync(abs, "utf-8");
      for (const snippet of rule.bannedSnippets) {
        if (content.includes(snippet)) {
          violations.push(
            `${rule.skillPath}: contains banned snippet "${snippet}"`,
          );
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Bundled skill retrieval contract regression detected.",
        "Migrated skills must not reintroduce direct gateway/keychain retrieval snippets.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("bundled skills do not contain direct keychain lookup instructions", () => {
    const violations: string[] = [];

    for (const skillFile of ALL_SKILL_FILES) {
      const rel = relative(ASSISTANT_DIR, skillFile).replaceAll("\\", "/");
      if (KEYCHAIN_ALLOWLIST.has(rel)) continue;
      const content = readFileSync(skillFile, "utf-8");
      for (const pattern of KEYCHAIN_PATTERNS) {
        if (content.includes(pattern)) {
          violations.push(`${rel}: contains "${pattern}"`);
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Direct keychain lookup instructions were found in bundled skills.",
        "Use credential_store and CLI/proxied flows instead.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Add intentional exceptions to KEYCHAIN_ALLOWLIST only when required.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("bundled skills do not require host_bash for Vellum CLI retrieval commands", () => {
    const violations: string[] = [];

    for (const skillFile of ALL_SKILL_FILES) {
      const rel = relative(ASSISTANT_DIR, skillFile).replaceAll("\\", "/");
      if (HOST_BASH_RETRIEVAL_ALLOWLIST.has(rel)) continue;
      const content = readFileSync(skillFile, "utf-8");
      const hasHostBash = content.includes("host_bash");
      if (!hasHostBash) continue;
      const hasRetrievalMarker = RETRIEVAL_MARKERS.some((marker) =>
        content.includes(marker),
      );
      if (!hasRetrievalMarker) continue;
      violations.push(
        `${rel}: contains host_bash with Vellum CLI retrieval markers (${RETRIEVAL_MARKERS.join(", ")})`,
      );
    }

    if (violations.length > 0) {
      const message = [
        "Bundled skills must not require host_bash for Vellum CLI retrieval commands.",
        "Use sandboxed bash for retrieval flows unless an explicit exception is documented.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Add intentional exceptions to HOST_BASH_RETRIEVAL_ALLOWLIST only when required.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
