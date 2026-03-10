import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(
  REPO_ROOT,
  "skills",
  "google-oauth-setup",
  "SKILL.md",
);
const CATALOG_PATH = resolve(REPO_ROOT, "skills", "catalog.json");

const skillContent = readFileSync(SKILL_PATH, "utf-8");
const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as {
  skills: Array<{
    id: string;
    description: string;
    metadata?: {
      vellum?: {
        includes?: string[];
        "credential-setup-for"?: string;
      };
    };
  }>;
};

const automatedSection =
  skillContent
    .split("# Path A: Automated Setup in Real Chrome")[1]
    ?.split("# Path B: Manual Desktop Setup")[0] ?? "";
const manualDesktopSection =
  skillContent
    .split("# Path B: Manual Desktop Setup")[1]
    ?.split("# Path C: Manual Channel Setup")[0] ?? "";
const manualChannelSection =
  skillContent
    .split("# Path C: Manual Channel Setup")[1]
    ?.split("## Guardrails and Error Handling")[0] ?? "";

describe("google-oauth-setup skill regression", () => {
  test("catalog metadata keeps only public-ingress include", () => {
    const skill = catalog.skills.find(
      (entry) => entry.id === "google-oauth-setup",
    );
    expect(skill).toBeDefined();
    expect(skill!.description).toContain("real Chrome on macOS");
    expect(skill!.description).not.toContain("browser automation");
    expect(skill!.metadata?.vellum?.includes).toEqual(["public-ingress"]);
    expect(skill!.metadata?.vellum?.["credential-setup-for"]).toBe("gmail");
  });

  test("automated macOS path uses real Chrome computer use rather than browser tools", () => {
    expect(automatedSection).toContain("computer_use_request_control");
    expect(automatedSection).toContain("computer_use_open_app");
    expect(automatedSection).toContain("computer_use_run_applescript");
    expect(automatedSection).toContain("Google Chrome");
    expect(automatedSection).not.toContain("browser_navigate");
    expect(automatedSection).not.toContain("browser_snapshot");
    expect(automatedSection).not.toContain("browser_screenshot");
    expect(automatedSection).not.toContain("browser_click");
  });

  test("manual desktop path creates Desktop app credentials", () => {
    expect(manualDesktopSection).toContain("Application type: **Desktop app**");
    expect(manualDesktopSection).not.toContain(
      "Application type: **Web application**",
    );
    expect(manualDesktopSection).toContain("credential_store prompt");
  });

  test("manual channel path keeps the public callback web-app flow", () => {
    expect(manualChannelSection).toContain("public-ingress");
    expect(manualChannelSection).toContain(
      "Application type: **Web application**",
    );
    expect(manualChannelSection).toContain("/webhooks/oauth/callback");
    expect(manualChannelSection).toContain("GOCSPX-");
  });
});
