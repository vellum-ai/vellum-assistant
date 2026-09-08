/**
 * Guard test: always-loaded tool count
 *
 * This test asserts the exact set of tools that are active when no client is
 * connected, no host proxy is available, and no special channel capabilities
 * exist. This represents the minimal "always-loaded"
 * baseline that is sent to the LLM on every turn.
 *
 * Adding a tool to this set increases token cost for every request. If this test
 * fails because a new tool was added, update the assertion below and justify
 * the token cost increase in the PR description.
 */

import { afterAll, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  initializeTools,
} from "../tools/registry.js";

afterAll(() => {
  __resetRegistryForTesting();
});

describe("always-loaded tool count", () => {
  test("should be exactly 11 with recall occupying the existing slot", async () => {
    await initializeTools();
    const allDefs = getAllToolDefinitions();

    // Minimal context: no client, no capabilities
    const minimalContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      toolsDisabledDepth: 0,
      hasNoClient: true,
      channelCapabilities: undefined,
    } as unknown as Conversation;

    const activeTools = allDefs.filter((def) =>
      isToolActiveForContext(def.name, minimalContext),
    );
    const activeNames = activeTools.map((t) => t.name).sort();

    // Host tools (host_bash, host_file_*) are excluded when no client is
    // connected — without a human in the loop, the guardian auto-approve
    // path would allow unchecked host command execution.
    //
    // `watch_retro_report` is here for the same reason the ui_surface tools are
    // NOT: a watch retrospective runs clientless, so it can only report through
    // a tool that survives this baseline. Its description and schema are kept
    // deliberately terse because that is the cost of the slot.
    const expectedNames = [
      "bash",
      "file_edit",
      "file_read",
      "file_write",
      "recall",
      "remember",
      "skill_execute",
      "skill_load",
      "watch_retro_report",
      "web_fetch",
      "web_search",
    ].sort();

    expect(activeNames).toEqual(expectedNames);
    expect(activeNames.filter((name) => name === "recall")).toHaveLength(1);
    expect(activeTools.length).toBe(11);
  });
});
