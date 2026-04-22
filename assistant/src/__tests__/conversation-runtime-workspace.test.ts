import { beforeEach, describe, expect, test } from "bun:test";

import { applyRuntimeInjections } from "../daemon/conversation-runtime-assembly.js";
import { defaultInjectorsPlugin } from "../plugins/defaults/injectors.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Fixture messages
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleContext =
  "<workspace>\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace>";

// The standalone `injectWorkspaceTopLevelContext` helper was removed in
// G2.1. The workspace-context default injector (registered by
// `defaultInjectorsPlugin`) now emits the workspace block as a
// `prepend-user-tail` placement during `applyRuntimeInjections`. The suite
// below exercises that end-to-end path instead.

describe("applyRuntimeInjections — workspace top-level context", () => {
  beforeEach(() => {
    // Post-G2.1: workspace injection is driven by the `workspace-context`
    // default injector, so the plugin must be registered for the chain to
    // produce a block. Each test gets a clean registry.
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
  });

  test("injects workspace context when provided", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toBe("Hello");
  });

  test("does not inject when workspace context is null", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      workspaceTopLevelContext: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
  });

  test("workspace context appears before active surface context in content", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
      workspaceTopLevelContext: sampleContext,
    });

    // Workspace is injected last (in applyRuntimeInjections order) so it
    // prepends to whatever was already prepended by activeSurface.
    // Result: [workspace, activeSurface, original]
    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
    expect((result[0].content[2] as { text: string }).text).toBe("Hello");
  });
});

describe("applyRuntimeInjections — minimal mode skips workspace blocks", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
  });

  test("minimal mode skips workspace top-level context", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("minimal mode skips active surface context", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("full mode (default) still includes workspace blocks", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
    });

    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
  });
});
