import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { SkillSummary } from "../../config/skills.js";
import * as skills from "../../config/skills.js";
import type { Conversation } from "../../daemon/conversation.js";
import * as conversationRegistry from "../../daemon/conversation-registry.js";
import { PLUGIN_NAME_ENV } from "../../plugin-api/plugin-name-env.js";
import {
  applyActivePluginName,
  uniqueActivePluginOwner,
} from "../active-plugin-env.js";

function pluginSkill(id: string, pluginId: string): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: id,
    directoryPath: `/tmp/${id}`,
    skillFilePath: `/tmp/${id}/SKILL.md`,
    source: "plugin",
    owner: { kind: "plugin", id: pluginId },
  };
}

function bundledSkill(id: string): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: id,
    directoryPath: `/tmp/${id}`,
    skillFilePath: `/tmp/${id}/SKILL.md`,
    source: "bundled",
  };
}

function conversationWithSkills(skillIds: string[]): Conversation {
  return {
    skillProjectionState: new Map(skillIds.map((id) => [id, "v1:hash"])),
  } as Conversation;
}

describe("uniqueActivePluginOwner", () => {
  let catalogSpy: ReturnType<typeof spyOn>;
  let conversationSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    catalogSpy?.mockRestore();
    conversationSpy?.mockRestore();
  });

  function stub(skillIds: string[], catalog: SkillSummary[]): void {
    conversationSpy = spyOn(
      conversationRegistry,
      "findConversationOrSubagent",
    ).mockReturnValue(conversationWithSkills(skillIds));
    catalogSpy = spyOn(skills, "loadSkillCatalog").mockReturnValue(catalog);
  }

  test("returns the owner when exactly one plugin skill is active", () => {
    stub(["sms-setup", "bash"], [
      pluginSkill("sms-setup", "sms"),
      bundledSkill("bash"),
    ]);
    expect(uniqueActivePluginOwner("conv-1")).toBe("sms");
  });

  test("returns undefined when no plugin skill is active", () => {
    stub(["bash"], [bundledSkill("bash")]);
    expect(uniqueActivePluginOwner("conv-1")).toBeUndefined();
  });

  test("returns undefined when two plugin owners are active", () => {
    stub(
      ["sms-setup", "linear-inbox"],
      [
        pluginSkill("sms-setup", "sms"),
        pluginSkill("linear-inbox", "linear"),
      ],
    );
    expect(uniqueActivePluginOwner("conv-1")).toBeUndefined();
  });

  test("treats two skills from the same plugin as a single owner", () => {
    stub(
      ["sms-setup", "sms-send"],
      [pluginSkill("sms-setup", "sms"), pluginSkill("sms-send", "sms")],
    );
    expect(uniqueActivePluginOwner("conv-1")).toBe("sms");
  });

  test("returns undefined without a conversation id", () => {
    expect(uniqueActivePluginOwner(undefined)).toBeUndefined();
    expect(uniqueActivePluginOwner("")).toBeUndefined();
  });
});

describe("applyActivePluginName", () => {
  let catalogSpy: ReturnType<typeof spyOn>;
  let conversationSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    catalogSpy?.mockRestore();
    conversationSpy?.mockRestore();
  });

  test("sets VELLUM_PLUGIN_NAME when a unique plugin owner is active", () => {
    conversationSpy = spyOn(
      conversationRegistry,
      "findConversationOrSubagent",
    ).mockReturnValue(conversationWithSkills(["sms-setup"]));
    catalogSpy = spyOn(skills, "loadSkillCatalog").mockReturnValue([
      pluginSkill("sms-setup", "sms"),
    ]);

    const env: NodeJS.ProcessEnv = {};
    applyActivePluginName(env, "conv-1");
    expect(env[PLUGIN_NAME_ENV]).toBe("sms");
  });

  test("leaves the env unchanged when no unique plugin owner is active", () => {
    conversationSpy = spyOn(
      conversationRegistry,
      "findConversationOrSubagent",
    ).mockReturnValue(conversationWithSkills(["sms-setup", "linear-inbox"]));
    catalogSpy = spyOn(skills, "loadSkillCatalog").mockReturnValue([
      pluginSkill("sms-setup", "sms"),
      pluginSkill("linear-inbox", "linear"),
    ]);

    const env: NodeJS.ProcessEnv = {};
    applyActivePluginName(env, "conv-1");
    expect(env[PLUGIN_NAME_ENV]).toBeUndefined();
  });
});
