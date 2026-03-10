import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const ASSISTANT_DIR = resolve(import.meta.dirname ?? __dirname, "..");
const MESSAGING_SKILL_PATH = resolve(
  ASSISTANT_DIR,
  "config",
  "bundled-skills",
  "messaging",
  "SKILL.md",
);

const skillContent = readFileSync(MESSAGING_SKILL_PATH, "utf-8");
const publicIngressSection =
  skillContent
    .split("### Public Ingress")[1]
    ?.split("### Email Connection Flow")[0] ?? "";
const gmailSection =
  skillContent.split("### Gmail")[1]?.split("### Slack")[0] ?? "";

describe("messaging skill Gmail setup regression", () => {
  test("public ingress section distinguishes desktop Gmail from channel Gmail", () => {
    expect(publicIngressSection).toContain(
      "Slack and Telegram setup require a publicly reachable URL",
    );
    expect(publicIngressSection).toContain(
      "**macOS desktop app:** Gmail setup can use Desktop app credentials",
    );
    expect(publicIngressSection).toContain(
      "**Non-interactive channels:** Gmail setup uses Web application credentials",
    );
  });

  test("gmail setup no longer claims google-oauth-setup depends on public-ingress", () => {
    expect(gmailSection).toContain(
      "let that skill choose the correct path for the current client",
    );
    expect(gmailSection).not.toContain(
      "depends on **public-ingress** for the redirect URI",
    );
  });

  test("gmail confirmation describes the real Chrome desktop path", () => {
    expect(gmailSection).toContain("I'll use your real Chrome window");
    expect(gmailSection).toContain(
      "If you're in a non-interactive channel, I'll guide you through the manual callback setup.",
    );
  });
});
