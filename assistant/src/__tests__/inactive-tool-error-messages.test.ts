/**
 * Tests for `buildInactiveToolMessage` — the error composed when a registered
 * tool is excluded from the current turn's active tool set.
 *
 * The message must name the gate that actually excluded the tool. The
 * telemetry failure mode this pins down: core tools gated by a subagent
 * allowlist or by client-context filtering were told to "load the skill that
 * provides this tool", which no skill does — models retried `skill_load` in a
 * loop instead of re-planning with the tools that exist.
 */

import { describe, expect, test } from "bun:test";

import { buildInactiveToolMessage } from "../tools/tool-approval-handler.js";

const ACTIVE = new Set(["bash", "file_read", "web_search"]);

describe("buildInactiveToolMessage", () => {
  test("subagent allowlist gate names the allowlist", () => {
    const msg = buildInactiveToolMessage({
      name: "skill_load",
      owner: undefined,
      subagentAllowedTools: new Set(["web_search", "file_read"]),
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    expect(msg).toBe(
      'Tool "skill_load" is not available to this subagent. This subagent may only use: file_read, web_search.',
    );
  });

  test("subagent allowlist outranks the skill-owner hint", () => {
    const msg = buildInactiveToolMessage({
      name: "pdf_extract",
      owner: { kind: "skill", id: "pdf-tools" },
      subagentAllowedTools: new Set(["web_search"]),
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    // Loading a skill cannot widen a subagent allowlist, so the skill hint
    // would send the model in a loop.
    expect(msg).toContain("not available to this subagent");
    expect(msg).not.toContain("Load the");
  });

  test("skill-owned tool keeps the named load hint", () => {
    const msg = buildInactiveToolMessage({
      name: "pdf_extract",
      owner: { kind: "skill", id: "pdf-tools" },
      subagentAllowedTools: undefined,
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    expect(msg).toBe(
      'Tool "pdf_extract" is not currently active. Load the "pdf-tools" skill that provides this tool first.',
    );
  });

  test("plugin-owned tool names the plugin, not a skill", () => {
    const msg = buildInactiveToolMessage({
      name: "acme_sync",
      owner: { kind: "plugin", id: "acme-plugin" },
      subagentAllowedTools: undefined,
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    expect(msg).toBe(
      'Tool "acme_sync" belongs to the "acme-plugin" plugin, which is not enabled for this conversation.',
    );
  });

  test("remember while memory is disabled says so", () => {
    const msg = buildInactiveToolMessage({
      name: "remember",
      owner: undefined,
      subagentAllowedTools: undefined,
      memoryEnabled: false,
      activeToolNames: ACTIVE,
    });
    expect(msg).toBe(
      'Tool "remember" is unavailable because memory is disabled for this assistant.',
    );
  });

  test("owner-less context gating lists the active tools instead of a skill hint", () => {
    const msg = buildInactiveToolMessage({
      name: "app_open",
      owner: undefined,
      subagentAllowedTools: undefined,
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    expect(msg).toBe(
      'Tool "app_open" is not available in this context. Available tools: bash, file_read, web_search',
    );
    expect(msg).not.toContain("Load the skill");
  });

  test("remember with memory enabled falls through to the context message", () => {
    const msg = buildInactiveToolMessage({
      name: "remember",
      owner: undefined,
      subagentAllowedTools: undefined,
      memoryEnabled: true,
      activeToolNames: ACTIVE,
    });
    expect(msg).toContain("not available in this context");
  });
});
