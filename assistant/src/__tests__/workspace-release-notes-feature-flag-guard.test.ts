import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

type Registry = {
  flags: Array<{
    key: string;
    scope: string;
    defaultEnabled: boolean;
  }>;
};

const LEGACY_FLAGGED_RELEASE_NOTE_ALLOWLIST = new Map<string, string>([
  [
    "045-release-notes-meet-avatar.ts",
    "Historical bulletin that already shipped before this guard existed.",
  ],
]);

const FLAGGED_FEATURE_LANGUAGE_PATTERNS: Array<{
  label: string;
  pattern: RegExp;
}> = [
  { label: "feature flag", pattern: /\bfeature[- ]flag(?:ged)?\b/i },
  { label: "rollout flag", pattern: /\brollout flag\b/i },
  { label: "behind ... flag", pattern: /\bbehind\b[^\n.]{0,120}\bflag\b/i },
  { label: "gated on", pattern: /\bgated on\b/i },
  { label: "when enabled", pattern: /\bwhen enabled\b/i },
];

function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

function getReleaseNoteMigrationFiles(): string[] {
  const migrationsDir = join(process.cwd(), "src", "workspace", "migrations");
  return readdirSync(migrationsDir)
    .filter((fileName) => /^\d+-release-notes-[a-z0-9-]+\.ts$/.test(fileName))
    .sort();
}

function loadDefaultDisabledAssistantFlagKeys(): string[] {
  const registryPath = join(
    getRepoRoot(),
    "meta",
    "feature-flags",
    "feature-flag-registry.json",
  );
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Registry;
  return registry.flags
    .filter((flag) => flag.scope === "assistant" && !flag.defaultEnabled)
    .map((flag) => flag.key)
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function featureFlagKeyPattern(key: string): RegExp {
  const escaped = escapeRegExp(key);
  if (key.includes("-")) {
    return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, "i");
  }

  return new RegExp("[`'\"]" + escaped + "[`'\"]", "i");
}

describe("workspace release-note migrations feature flag guard", () => {
  test("new release-note migrations do not announce default-disabled feature-flagged work", () => {
    const migrationsDir = join(process.cwd(), "src", "workspace", "migrations");
    const defaultDisabledFlagKeys = loadDefaultDisabledAssistantFlagKeys();
    const violations: string[] = [];

    for (const fileName of getReleaseNoteMigrationFiles()) {
      if (LEGACY_FLAGGED_RELEASE_NOTE_ALLOWLIST.has(fileName)) {
        continue;
      }

      const content = readFileSync(join(migrationsDir, fileName), "utf-8");

      for (const { label, pattern } of FLAGGED_FEATURE_LANGUAGE_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(
            `${fileName}: contains flagged-feature language "${label}"`,
          );
        }
      }

      for (const key of defaultDisabledFlagKeys) {
        if (featureFlagKeyPattern(key).test(content)) {
          violations.push(
            `${fileName}: references default-disabled assistant feature flag "${key}"`,
          );
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Release-note migrations write to UPDATES.md, which is processed without checking feature flags.",
        "Do not announce features that are still behind default-disabled assistant flags or rollout flags.",
        "Wait until GA and add a new append-only release-note migration with a new marker.",
        "",
        "Violations:",
        ...violations.map((violation) => `  - ${violation}`),
        "",
        "If this is an already-shipped historical bulletin, add a narrow entry to",
        "LEGACY_FLAGGED_RELEASE_NOTE_ALLOWLIST in workspace-release-notes-feature-flag-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
