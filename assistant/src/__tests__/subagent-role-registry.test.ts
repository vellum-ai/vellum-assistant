import { describe, expect, test } from "bun:test";

import { READ_ONLY_ALLOWED_TOOLS } from "../daemon/conversation-tool-setup.js";
import {
  mergeSkillIds,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentRole,
} from "../subagent/index.js";
import { buildSubagentSystemPrompt } from "../subagent/manager.js";
import type { SubagentConfig } from "../subagent/types.js";

/** All roles defined in the SubagentRole union. */
const ALL_ROLES: SubagentRole[] = ["researcher", "builder", "advisor"];

describe("SUBAGENT_ROLE_REGISTRY", () => {
  test("covers all values in the SubagentRole union", () => {
    const registryKeys = Object.keys(SUBAGENT_ROLE_REGISTRY);
    expect(registryKeys.sort()).toEqual([...ALL_ROLES].sort());
    expect(registryKeys).toHaveLength(ALL_ROLES.length);
  });

  test("every role has a non-empty systemPromptPreamble", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      expect(config.systemPromptPreamble.length).toBeGreaterThan(0);
    }
  });

  test("the read-only roles declare an explicit allowlist", () => {
    for (const role of ["researcher", "advisor"] as const) {
      expect(Array.isArray(SUBAGENT_ROLE_REGISTRY[role].allowedTools)).toBe(
        true,
      );
    }
    expect(
      SUBAGENT_ROLE_REGISTRY.researcher.allowedTools!.length,
    ).toBeGreaterThan(0);
  });

  test("builder declares no allowlist, so it keeps the parent's whole tool surface", () => {
    // The regression this guards: an explicit list is a ceiling. A builder
    // scoped to file/shell/web tools silently loses connectors, MCP tools,
    // browser and computer use, and everything else the parent can reach.
    expect(SUBAGENT_ROLE_REGISTRY.builder.allowedTools).toBeUndefined();
  });

  test("advisor is scoped to exactly the three read-only fact-checking tools", () => {
    expect(SUBAGENT_ROLE_REGISTRY.advisor.allowedTools).toEqual([
      "file_read",
      "file_list",
      "code_search",
    ]);
  });

  test("advisor cannot search memory or other conversations", () => {
    // `recall` searches memory, the personal knowledge base, and prior
    // conversations. The consult's documented contract is this conversation
    // plus what the advisor reads in the workspace, so the one tool that
    // reaches past it stays out.
    expect(SUBAGENT_ROLE_REGISTRY.advisor.allowedTools).not.toContain("recall");
    expect(SUBAGENT_ROLE_REGISTRY.advisor.systemPromptPreamble).toContain(
      "cannot see other conversations",
    );
  });

  test("every advisor tool is inside the runtime's owner-gated read-only set", () => {
    // The advisor spawn sets `denySideEffectTools`, so a name outside
    // READ_ONLY_ALLOWED_TOOLS is admitted by the role and then refused at
    // dispatch: the model would be shown a tool it cannot run. Keeping the
    // allowlist a subset is what makes the two gates agree.
    for (const name of SUBAGENT_ROLE_REGISTRY.advisor.allowedTools!) {
      expect(READ_ONLY_ALLOWED_TOOLS.has(name)).toBe(true);
    }
  });

  test("advisor is read-only: nothing write-capable, no shell, no skill execution", () => {
    // The consult is a judgment call the parent blocks on, so the advisor must
    // never be able to act on the workspace or persist output of its own.
    const tools = SUBAGENT_ROLE_REGISTRY.advisor.allowedTools!;
    for (const forbidden of [
      "bash",
      "host_bash",
      "file_write",
      "file_edit",
      "skill_execute",
      "web_fetch",
      "recall",
    ]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  test("researcher preamble discourages slicing without instructing whole-file reads", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.researcher.systemPromptPreamble;
    // `file_read` takes no default line limit and its results skip result-time
    // spooling, so a whole-file instruction puts full bodies on every LLM call
    // for the rest of the turn. Keep the anti-slicing guidance without it.
    expect(preamble.toLowerCase()).not.toContain("read whole files");
    expect(preamble).toContain("one pass rather than many small slices");
  });

  test("advisor preamble states it can verify facts but cannot change anything", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.advisor.systemPromptPreamble;
    expect(preamble).toContain("read and search the files");
    expect(preamble).toContain("cannot change anything");
    expect(preamble).not.toContain("no tools");
  });

  test("SubagentRole type includes advisor", () => {
    const advisor: SubagentRole = "advisor";
    expect(SUBAGENT_ROLE_REGISTRY[advisor]).toBeDefined();
  });

  test('every allowlisted background role includes "notify_parent"', () => {
    // Mid-run reporting only means something for a role the parent does not
    // wait on. The advisor blocks the parent turn and returns its guidance as
    // the tool result, so it intentionally has no notify_parent.
    expect(SUBAGENT_ROLE_REGISTRY.researcher.allowedTools).toContain(
      "notify_parent",
    );
    expect(SUBAGENT_ROLE_REGISTRY.advisor.allowedTools).not.toContain(
      "notify_parent",
    );
  });

  test('the scoped tool-using role includes "skill_execute" so preactivated skills work', () => {
    // Without it, `preactivatedSkillIds` is a silent no-op for the role: the
    // skill loads and none of its tools can be reached. Only an allowlisted
    // role can lose it.
    expect(SUBAGENT_ROLE_REGISTRY.researcher.allowedTools).toContain(
      "skill_execute",
    );
  });

  test('researcher includes "recall" for local information access', () => {
    const tools = SUBAGENT_ROLE_REGISTRY.researcher.allowedTools!;
    expect(tools).toContain("recall");
  });

  test("researcher is read-only: no shell, no file writes", () => {
    const tools = SUBAGENT_ROLE_REGISTRY.researcher.allowedTools!;
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("host_bash");
    expect(tools).not.toContain("file_write");
    expect(tools).not.toContain("file_edit");
  });

  test("researcher can search and enumerate as well as read", () => {
    const tools = SUBAGENT_ROLE_REGISTRY.researcher.allowedTools!;
    expect(tools).toContain("code_search");
    expect(tools).toContain("file_list");
    expect(tools).toContain("web_search");
    expect(tools).toContain("web_fetch");
  });

  test("researcher preamble carries the read-only investigation contract", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.researcher.systemPromptPreamble;
    expect(preamble).toContain("Root cause");
    expect(preamble).toContain("Evidence");
    expect(preamble).toContain("notify_parent");
    expect(preamble).toContain("code_search");
    expect(preamble).toContain("no shell");
  });

  test("builder preamble states it can write, run commands, and reach the parent's other tools", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.builder.systemPromptPreamble;
    expect(preamble).toContain("edit files");
    expect(preamble).toContain("shell commands");
    expect(preamble).toContain("any other tool the parent conversation can");
  });

  test("builder preamble requires self-verification and a change report", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.builder.systemPromptPreamble;
    expect(preamble).toContain("verify");
    expect(preamble).toContain("files you touched");
  });

  test("no role references the old memory_recall tool name", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      if (config.allowedTools !== undefined) {
        expect(config.allowedTools).not.toContain("memory_recall");
      }
    }
  });

  test("every role has empty skillIds (no skill preactivation)", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      expect(config.skillIds).toEqual([]);
    }
  });
});

describe("buildSubagentSystemPrompt: framing and constraints", () => {
  const cfg = (
    objective: string,
    extra: Partial<SubagentConfig> = {},
  ): SubagentConfig => ({
    id: "sub-1",
    parentConversationId: "conv-1",
    label: "task",
    objective,
    ...extra,
  });

  test("every role's constructed prompt tells it to signal blocked instead of fabricating a result", () => {
    for (const role of ALL_ROLES) {
      const prompt = buildSubagentSystemPrompt(
        cfg("write the results to a CSV file"),
        role,
      );
      expect(prompt).toContain("notify_parent");
      expect(prompt).toContain('urgency "blocked"');
      expect(prompt).toContain("do NOT fabricate");
    }
  });

  test("the blocked-signal guidance is shared (Constraints), not baked into per-role preambles", () => {
    // A read-only role and a write-capable role both receive it (role-agnostic).
    expect(
      buildSubagentSystemPrompt(cfg("save output"), "researcher"),
    ).toContain("do NOT fabricate");
    expect(buildSubagentSystemPrompt(cfg("save output"), "builder")).toContain(
      "do NOT fabricate",
    );
    // It is NOT duplicated into the researcher role's own preamble.
    expect(
      SUBAGENT_ROLE_REGISTRY.researcher.systemPromptPreamble,
    ).not.toContain("do NOT fabricate");
  });

  test("every role is also told not to invent output for a tool that failed or was missing", () => {
    // The blocked-signal line above only covers a capability the ROLE lacks.
    // This one covers the runtime cases: the call failed, or the tool was not
    // there at all.
    for (const role of ALL_ROLES) {
      const prompt = buildSubagentSystemPrompt(cfg("run the build"), role);
      expect(prompt).toContain(
        "If a tool call fails, or a tool you expected is unavailable, report the failure verbatim and stop that line of work.",
      );
      expect(prompt).toContain(
        "Never simulate, reconstruct, or invent tool output you did not actually receive.",
      );
    }
  });

  test("a persona renders as a line under the role preamble", () => {
    const prompt = buildSubagentSystemPrompt(
      cfg("assess the filing", { persona: "financial journalist" }),
      "researcher",
    );
    expect(prompt).toContain(
      "- Persona: act as financial journalist for this task.",
    );
    // Under the preamble, above the task.
    expect(prompt.indexOf("- Persona:")).toBeGreaterThan(
      prompt.indexOf(SUBAGENT_ROLE_REGISTRY.researcher.systemPromptPreamble),
    );
    expect(prompt.indexOf("- Persona:")).toBeLessThan(
      prompt.indexOf("## Your Task"),
    );
  });

  test("no persona line when the spawn carried none", () => {
    expect(
      buildSubagentSystemPrompt(cfg("do the work"), "builder"),
    ).not.toContain("- Persona:");
  });

  test("the prompt names the type that ran", () => {
    const prompt = buildSubagentSystemPrompt(
      cfg("continue the work"),
      "builder",
    );
    expect(prompt).toContain("## Your Task");
    expect(prompt).toContain("- Role: builder");
  });
});

describe("mergeSkillIds", () => {
  test("removes duplicates between role and config skill IDs", () => {
    expect(mergeSkillIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("returns only role skills when config is undefined", () => {
    expect(mergeSkillIds(["subagent"], undefined)).toEqual(["subagent"]);
  });

  test("includes caller-provided extras alongside role skills", () => {
    expect(mergeSkillIds(["subagent"], ["custom-skill"])).toEqual([
      "subagent",
      "custom-skill",
    ]);
  });

  test("returns empty array when both inputs are empty", () => {
    expect(mergeSkillIds([], undefined)).toEqual([]);
  });
});
