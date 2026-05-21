import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "slack-app-setup", "SKILL.md");
const MANIFEST_SCRIPT_PATH = resolve(
  REPO_ROOT,
  "skills",
  "slack-app-setup",
  "generate-manifest-url.ts",
);

const skillContent = readFileSync(SKILL_PATH, "utf-8");

interface SlackManifest {
  display_information: {
    name?: string;
    description?: string;
  };
  features: {
    bot_user: {
      display_name?: string;
    };
    assistant_view: {
      assistant_description?: string;
    };
  };
}

function decodeManifest(url: string): SlackManifest {
  const manifestJson = new URL(url).searchParams.get("manifest_json");
  expect(manifestJson).toBeTruthy();
  return JSON.parse(manifestJson!) as SlackManifest;
}

describe("slack-app-setup skill regression", () => {
  test("keeps Slack token collection on the secure credential prompt path", () => {
    expect(skillContent).toContain(
      '`credential_store` with `action: "prompt"`',
    );
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
  });

  test("forbids plaintext forms and chat-pasted secrets", () => {
    expect(skillContent).toContain("Do NOT use `ui_show`");
    expect(skillContent).toContain(
      "Do NOT ask the user to paste tokens in chat",
    );
  });

  test("infers Slack app identity instead of asking the user to confirm it", () => {
    expect(skillContent).toContain(
      "Do not ask the user to confirm the Slack bot name or description first.",
    );
    expect(skillContent).toContain(
      "bun skills/slack-app-setup/generate-manifest-url.ts",
    );
    expect(skillContent).not.toContain(
      "Ask the user what they'd like to name their Slack bot",
    );
    expect(skillContent).not.toContain("<user_name>");
    expect(skillContent).not.toContain("<user_description>");
  });

  test("manifest generator infers assistant name and guardian description", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "slack-app-setup-"));
    try {
      mkdirSync(join(workspaceDir, "users"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "IDENTITY.md"),
        "# Identity\n\n- **Name:** Nova\n",
      );
      writeFileSync(
        join(workspaceDir, "users", "default.md"),
        "# User Profile\n\n- Preferred name/reference: Alice\n",
      );

      const result = Bun.spawnSync({
        cmd: [process.execPath, MANIFEST_SCRIPT_PATH],
        env: { ...process.env, VELLUM_WORKSPACE_DIR: workspaceDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode, stderr).toBe(0);

      const manifest = decodeManifest(
        new TextDecoder().decode(result.stdout).trim(),
      );
      expect(manifest.display_information.name).toBe("Nova");
      expect(manifest.display_information.description).toBe(
        "Alice's Assistant",
      );
      expect(manifest.features.bot_user.display_name).toBe("Nova");
      expect(manifest.features.assistant_view.assistant_description).toBe(
        "Alice's Assistant",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("does not instruct the agent to reimplement Slack validation in shell", () => {
    expect(skillContent).not.toContain(
      "assistant credentials reveal --service slack_channel",
    );
    expect(skillContent).not.toContain(
      'curl -sf -X POST "https://slack.com/api/auth.test"',
    );
    expect(skillContent).not.toContain("assistant config set slack.teamId");
    expect(skillContent).not.toContain("assistant config set slack.teamName");
    expect(skillContent).not.toContain("assistant config set slack.botUserId");
    expect(skillContent).not.toContain(
      "assistant config set slack.botUsername",
    );
  });
});
