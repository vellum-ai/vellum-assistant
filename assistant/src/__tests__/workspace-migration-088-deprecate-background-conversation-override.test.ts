import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deprecateBackgroundConversationOverrideMigration } from "../workspace/migrations/088-deprecate-background-conversation-override.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-088-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function promptSystemDir(): string {
  return join(workspaceDir, "prompts", "system");
}

function writeOverride(body: string): string {
  const dir = promptSystemDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "08-background-conversation.md");
  writeFileSync(filePath, body, "utf-8");
  return filePath;
}

describe("088-deprecate-background-conversation-override migration", () => {
  test("has expected id and description", () => {
    expect(deprecateBackgroundConversationOverrideMigration.id).toBe(
      "088-deprecate-background-conversation-override",
    );
    expect(
      deprecateBackgroundConversationOverrideMigration.description,
    ).toContain("08-background-conversation");
  });

  test("renames the override to .deprecated, preserving body", () => {
    const body = "## Custom\n\nUser-customized background note.\n";
    writeOverride(body);

    deprecateBackgroundConversationOverrideMigration.run(workspaceDir);

    const originalPath = join(
      promptSystemDir(),
      "08-background-conversation.md",
    );
    const deprecatedPath = join(
      promptSystemDir(),
      "08-background-conversation.md.deprecated",
    );

    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(deprecatedPath)).toBe(true);
    expect(readFileSync(deprecatedPath, "utf-8")).toBe(body);
  });

  test("no-ops when the override is absent", () => {
    expect(() =>
      deprecateBackgroundConversationOverrideMigration.run(workspaceDir),
    ).not.toThrow();

    const deprecatedPath = join(
      promptSystemDir(),
      "08-background-conversation.md.deprecated",
    );
    expect(existsSync(deprecatedPath)).toBe(false);
  });

  test("does not touch unrelated section overrides", () => {
    const dir = promptSystemDir();
    mkdirSync(dir, { recursive: true });
    const otherPath = join(dir, "07-external-content.md");
    writeFileSync(otherPath, "## External Content\n\nUntouched.\n", "utf-8");
    writeOverride("body");

    deprecateBackgroundConversationOverrideMigration.run(workspaceDir);

    expect(readFileSync(otherPath, "utf-8")).toContain("Untouched");
  });

  test("is safe to re-run after the rename has happened", () => {
    writeOverride("body");

    deprecateBackgroundConversationOverrideMigration.run(workspaceDir);
    expect(() =>
      deprecateBackgroundConversationOverrideMigration.run(workspaceDir),
    ).not.toThrow();

    const deprecatedPath = join(
      promptSystemDir(),
      "08-background-conversation.md.deprecated",
    );
    expect(readFileSync(deprecatedPath, "utf-8")).toBe("body");
  });

  test("drops the .md and keeps the .deprecated copy when both exist", () => {
    // A user re-created the override after a prior partial run. The bundled
    // section is gone, so the .md would render unconditionally — drop it.
    const dir = promptSystemDir();
    mkdirSync(dir, { recursive: true });
    const deprecatedPath = join(
      dir,
      "08-background-conversation.md.deprecated",
    );
    writeFileSync(deprecatedPath, "preserved.\n", "utf-8");
    const recreatedPath = writeOverride("re-created body\n");

    deprecateBackgroundConversationOverrideMigration.run(workspaceDir);

    expect(existsSync(recreatedPath)).toBe(false);
    expect(readFileSync(deprecatedPath, "utf-8")).toBe("preserved.\n");
  });

  test("down() restores the override when only .deprecated exists", () => {
    writeOverride("body");
    deprecateBackgroundConversationOverrideMigration.run(workspaceDir);

    deprecateBackgroundConversationOverrideMigration.down(workspaceDir);

    const overridePath = join(
      promptSystemDir(),
      "08-background-conversation.md",
    );
    const deprecatedPath = join(
      promptSystemDir(),
      "08-background-conversation.md.deprecated",
    );
    expect(existsSync(overridePath)).toBe(true);
    expect(existsSync(deprecatedPath)).toBe(false);
    expect(readFileSync(overridePath, "utf-8")).toBe("body");
  });

  test("down() is a no-op when only the .md exists", () => {
    writeOverride("body");

    expect(() =>
      deprecateBackgroundConversationOverrideMigration.down(workspaceDir),
    ).not.toThrow();

    const overridePath = join(
      promptSystemDir(),
      "08-background-conversation.md",
    );
    expect(readFileSync(overridePath, "utf-8")).toBe("body");
  });
});
