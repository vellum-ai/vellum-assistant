import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { conversationRevealNonce } from "../../runtime/reveal-nonce.js";
import { getWorkspaceDir, getWorkspacePluginsDir } from "../../util/platform.js";
import {
  authorizePluginSkillScript,
  runPluginSkillScript,
} from "../plugin-skill-script-runner.js";
import { _resetPluginSkillGrantsForTest } from "../plugin-skill-invocation.js";

const PLUGIN_DIR = "psk-demo";
const SKILL_ID = "psk-demo-skill";
const CONV_ID = "conv-xyz";

function writePluginSkill(scriptBody: string): string {
  const pluginDir = join(getWorkspacePluginsDir(), PLUGIN_DIR);
  const skillDir = join(pluginDir, "skills", SKILL_ID);
  const scriptsDir = join(skillDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: "authored-package-name",
      version: "1.0.0",
      peerDependencies: { "@vellumai/plugin-api": "*" },
    }),
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${SKILL_ID}\ndescription: Demo plugin skill.\n---\n\nBody.\n`,
  );
  const scriptPath = join(scriptsDir, "echo.ts");
  writeFileSync(scriptPath, scriptBody);
  return skillDir;
}

function writeWorkspaceSkill(): void {
  const skillDir = join(getWorkspaceDir(), "skills", "workspace-demo");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: workspace-demo\ndescription: Workspace skill.\n---\n\nBody.\n",
  );
  writeFileSync(
    join(skillDir, "scripts", "echo.ts"),
    "console.log('workspace');\n",
  );
}

function activateSkill(skillId: string = SKILL_ID): void {
  setConversation(CONV_ID, {
    skillProjectionState: new Map([[skillId, "v1"]]),
  } as unknown as Conversation);
}

beforeEach(() => {
  _resetPluginSkillGrantsForTest();
  clearConversations();
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
  rmSync(join(getWorkspaceDir(), "skills"), { recursive: true, force: true });
});

afterEach(() => {
  _resetPluginSkillGrantsForTest();
  clearConversations();
});

describe("authorizePluginSkillScript", () => {
  test("accepts an active plugin-resident script using catalog owner identity", () => {
    writePluginSkill("console.log('ok');\n");
    activateSkill();
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pluginName).toBe(PLUGIN_DIR);
      expect(result.relativeScript).toBe("scripts/echo.ts");
    }
  });

  test("rejects a workspace skill that is not plugin-owned", () => {
    writeWorkspaceSkill();
    activateSkill("workspace-demo");
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: "workspace-demo",
      script: "scripts/echo.ts",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_plugin_owned");
    }
  });

  test("rejects an inactive plugin skill", () => {
    writePluginSkill("console.log('ok');\n");
    setConversation(CONV_ID, {
      skillProjectionState: new Map(),
    } as unknown as Conversation);
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("skill_not_active");
    }
  });

  test("rejects a forged nonce", () => {
    writePluginSkill("console.log('ok');\n");
    activateSkill();
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
      revealNonce: "forged-nonce",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_nonce");
    }
  });

  test("accepts the conversation nonce when provided", () => {
    writePluginSkill("console.log('ok');\n");
    activateSkill();
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
      revealNonce: conversationRevealNonce(CONV_ID),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects parent-directory, absolute, and non-scripts paths", () => {
    writePluginSkill("console.log('ok');\n");
    activateSkill();
    const cases = [
      "scripts/../SKILL.md",
      "/tmp/echo.ts",
      "SKILL.md",
      "references/notes.md",
    ];
    for (const script of cases) {
      const result = authorizePluginSkillScript({
        conversationId: CONV_ID,
        skillId: SKILL_ID,
        script,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_script");
      }
    }
  });

  test("rejects a conversation that is not live", () => {
    writePluginSkill("console.log('ok');\n");
    const result = authorizePluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("conversation_not_live");
    }
  });
});

describe("runPluginSkillScript", () => {
  test("executes the script with a grant and without a reveal nonce", async () => {
    writePluginSkill(`
const grant = process.env.VELLUM_PLUGIN_SKILL_INVOCATION ?? "";
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  hasGrant: grant.startsWith("psk1."),
  hasReveal: process.env.__REVEAL_NONCE !== undefined,
  forgedName: process.env.VELLUM_PLUGIN_NAME ?? null,
}));
`);
    activateSkill();
    const result = await runPluginSkillScript({
      conversationId: CONV_ID,
      skillId: SKILL_ID,
      script: "scripts/echo.ts",
      args: ["list"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      argv: string[];
      hasGrant: boolean;
      hasReveal: boolean;
      forgedName: string | null;
    };
    expect(payload.argv).toEqual(["list"]);
    expect(payload.hasGrant).toBe(true);
    expect(payload.hasReveal).toBe(false);
    expect(payload.forgedName).toBeNull();
    expect(result.stdout).not.toContain("psk1.");
  });
});
