/**
 * The gate that decides whether a watch retrospective can report at all.
 *
 * A retrospective runs as a `clientless` wake, but its report continues to
 * use the post-turn renderer so the report lands after its tool call has been
 * persisted. The core UI tools remain available on that turn for other
 * background work, so this file pins both contracts against the real registry.
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

/** What a clientless wake looks like to the tool gate. */
function clientlessContext(): Conversation {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {},
    toolsDisabledDepth: 0,
    hasNoClient: true,
    channelCapabilities: undefined,
  } as unknown as Conversation;
}

/** The same conversation with a client attached, for contrast. */
function clientfulContext(): Conversation {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {},
    toolsDisabledDepth: 0,
    hasNoClient: false,
    channelCapabilities: undefined,
  } as unknown as Conversation;
}

describe("watch retrospective tool availability", () => {
  test("the retrospective can report without a client", async () => {
    await initializeTools();
    expect(
      isToolActiveForContext("watch_retro_report", clientlessContext()),
    ).toBe(true);
  });

  test("core UI tools stay available on a clientless turn", async () => {
    await initializeTools();
    const ctx = clientlessContext();

    for (const name of ["ui_show", "ui_update", "ui_dismiss"]) {
      expect(isToolActiveForContext(name, ctx)).toBe(true);
    }

    const withClient = clientfulContext();
    expect(isToolActiveForContext("ui_show", withClient)).toBe(true);
  });

  test("the report tool is registered, not skill-projected", async () => {
    await initializeTools();
    const names = getAllToolDefinitions().map((def) => def.name);
    // A skill-projected tool would need its skill loaded first, and the
    // retrospective's `skill_load` is itself denied in a clientless wake.
    expect(names).toContain("watch_retro_report");
  });
});
