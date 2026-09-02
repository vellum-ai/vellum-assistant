/**
 * The gate that decides whether a watch retrospective can report at all.
 *
 * A retrospective runs as a `clientless` wake, which pins the turn
 * non-interactive. `conversation-tool-setup` gates the whole `ui_surface`
 * family on a client being present, so in that turn `ui_show` is not denied,
 * it is absent: a retrospective told to call it can only tell the user it
 * cannot. Nothing about the card's schema, its renderer, or the prompt's
 * wording reveals that, which is why it is asserted here against the real
 * registry rather than assumed anywhere else.
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

  test("ui_show is absent from a clientless turn", async () => {
    await initializeTools();
    const ctx = clientlessContext();

    // The reason the report does not go through `ui_show`. If this ever flips
    // to true, the extra tool above can be reconsidered; while it is false,
    // routing the retrospective's card through `ui_show` produces a turn that
    // cannot report at all.
    expect(isToolActiveForContext("ui_show", ctx)).toBe(false);
    expect(isToolActiveForContext("ui_update", ctx)).toBe(false);
    expect(isToolActiveForContext("ui_dismiss", ctx)).toBe(false);

    // And the gate really is about the client, not about the tools being
    // unregistered: with one attached, the same names are active.
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
