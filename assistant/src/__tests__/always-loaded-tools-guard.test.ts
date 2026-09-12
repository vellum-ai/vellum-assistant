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
  test("should be exactly 19 with recall occupying the existing slot", async () => {
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

    // `watch_retro_report` survives this baseline for the same reason the
    // ui_* tools do: a watch retrospective runs clientless, so it can only
    // report through a tool that survives this baseline. The ui_* tools are
    // here because background UI surfaces persist and return instead of
    // awaiting action, so they no longer need a connected client.
    // Host tool definitions stay on the wire for background turns: schemas
    // are cache-stable, and the shared execution gate rejects host tools on
    // explicitly non-interactive turns before any proxy dispatch.
    const expectedNames = [
      "bash",
      "file_edit",
      "file_read",
      "file_write",
      "host_bash",
      "host_file_edit",
      "host_file_read",
      "host_file_transfer",
      "host_file_write",
      "recall",
      "remember",
      "skill_execute",
      "skill_load",
      "ui_dismiss",
      "ui_show",
      "ui_update",
      "watch_retro_report",
      "web_fetch",
      "web_search",
    ].sort();

    expect(activeNames).toEqual(expectedNames);
    expect(activeNames.filter((name) => name === "recall")).toHaveLength(1);
    expect(activeTools.length).toBe(19);
  });
});
