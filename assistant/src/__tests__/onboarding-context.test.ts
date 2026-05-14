import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { OnboardingContext } from "../types/onboarding-context.js";

// Dynamic import so WORKSPACE_DIR override takes effect before module init.
const { getOnboardingSidecarPath, writeOnboardingSidecar } =
  await import("../home/relationship-state-writer.js");

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "onboarding-ctx-test-"));
  origWorkspaceDir = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.WORKSPACE_DIR;
  } else {
    process.env.WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("OnboardingContext googleConnected field", () => {
  test("googleConnected: true is persisted to the sidecar file", () => {
    const ctx: OnboardingContext = {
      tools: ["Gmail"],
      tasks: ["Inbox triage"],
      tone: "Friendly",
      userName: "Alex",
      assistantName: "Nova",
      googleConnected: true,
    };

    writeOnboardingSidecar(ctx);

    const path = getOnboardingSidecarPath();
    expect(existsSync(path)).toBe(true);

    const decoded = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as OnboardingContext;
    expect(decoded.googleConnected).toBe(true);
    // Verify other fields are still present
    expect(decoded.tools).toEqual(["Gmail"]);
    expect(decoded.tasks).toEqual(["Inbox triage"]);
    expect(decoded.tone).toBe("Friendly");
    expect(decoded.userName).toBe("Alex");
    expect(decoded.assistantName).toBe("Nova");
  });

  test("omitting googleConnected still works (backward compat)", () => {
    const ctx: OnboardingContext = {
      tools: ["Slack"],
      tasks: ["Meeting prep"],
      tone: "Dry and precise",
    };

    writeOnboardingSidecar(ctx);

    const path = getOnboardingSidecarPath();
    expect(existsSync(path)).toBe(true);

    const decoded = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as OnboardingContext;
    expect(decoded.googleConnected).toBeUndefined();
    expect(decoded.tools).toEqual(["Slack"]);
    expect(decoded.tasks).toEqual(["Meeting prep"]);
    expect(decoded.tone).toBe("Dry and precise");
  });

  test("googleConnected: false is persisted correctly", () => {
    const ctx: OnboardingContext = {
      tools: [],
      tasks: [],
      tone: "",
      googleConnected: false,
    };

    writeOnboardingSidecar(ctx);

    const path = getOnboardingSidecarPath();
    const decoded = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as OnboardingContext;
    expect(decoded.googleConnected).toBe(false);
  });

  test("googleScopes and abVariant round-trip through the sidecar", () => {
    const ctx: OnboardingContext = {
      tools: ["Gmail"],
      tasks: ["Inbox triage"],
      tone: "Friendly",
      googleConnected: true,
      googleScopes: ["gmail.readonly", "calendar.readonly"],
      abVariant: "pre-chat-oauth",
    };

    writeOnboardingSidecar(ctx);

    const path = getOnboardingSidecarPath();
    const decoded = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as OnboardingContext;
    expect(decoded.googleScopes).toEqual([
      "gmail.readonly",
      "calendar.readonly",
    ]);
    expect(decoded.abVariant).toBe("pre-chat-oauth");
  });
});
