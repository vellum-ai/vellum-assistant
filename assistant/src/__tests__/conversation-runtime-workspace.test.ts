import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyRuntimeInjections } from "../daemon/conversation-runtime-assembly.js";
import {
  registerConversationWorkspace,
  unregisterConversationWorkspace,
  type WorkspaceConversationContext,
} from "../daemon/conversation-workspace.js";
import { defaultInjectorsPlugin } from "../plugins/defaults/injectors/register.js";
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

// `applyRuntimeInjections` synthesizes this conversation id when no
// `turnContext` is supplied, so the `workspace-context` injector resolves the
// live workspace block from the registry under this key.
const FALLBACK_CONVERSATION_ID = "runtime-assembly-fallback";

let registeredWorkspace: WorkspaceConversationContext | null = null;

// Seed the workspace registry with a pre-rendered top-level block. The cache
// is non-dirty with non-null content, so `resolveWorkspaceTopLevelContext`
// returns it verbatim without rescanning the filesystem.
function seedWorkspaceContext(text: string): void {
  registeredWorkspace = {
    conversationId: FALLBACK_CONVERSATION_ID,
    workingDir: "/sandbox",
    workspaceTopLevelContext: text,
    workspaceTopLevelDirty: false,
  };
  registerConversationWorkspace(registeredWorkspace);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleContext =
  "<workspace>\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace>";

// The workspace-context default injector (registered by
// `defaultInjectorsPlugin`) emits the workspace block as a
// `prepend-user-tail` placement during `applyRuntimeInjections`. It sources
// the rendered block from the per-conversation workspace registry and
// (re)injects only when the block is absent from the working messages, so the
// suite seeds the registry and exercises that end-to-end path.

describe("applyRuntimeInjections — workspace top-level context", () => {
  beforeEach(() => {
    // Workspace injection is driven by the `workspace-context` default
    // injector, so the plugin must be registered for the chain to produce a
    // block. Each test gets a clean registry.
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
  });

  afterEach(() => {
    if (registeredWorkspace) {
      unregisterConversationWorkspace(registeredWorkspace);
      registeredWorkspace = null;
    }
  });

  test("injects workspace context when registered", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {});

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toBe("Hello");
  });

  test("does not inject when no workspace context is registered", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {});

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
  });

  test("does not re-inject when the workspace block is already present", async () => {
    // GIVEN the registry holds a workspace block AND the working messages
    // already carry that block (a normal cached turn, post-injection).
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg(sampleContext), userMsg("Hello")];

    // WHEN injections are applied
    const { messages: result } = await applyRuntimeInjections(messages, {});

    // THEN presence detection skips the block to keep the prefix stable.
    expect(result).toHaveLength(2);
    expect(result[1].content).toHaveLength(1);
    expect((result[1].content[0] as { text: string }).text).toBe("Hello");
  });

  test("workspace context appears before active surface context in content", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
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

  test("app-backed active surface tells the model to load app-builder with the right argument", async () => {
    const messages: Message[] = [userMsg("Edit this app")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      activeSurface: {
        surfaceId: "sf_1",
        html: "<div>test</div>",
        appId: "app-1",
        appName: "Example App",
      },
    });

    const activeWorkspaceText = (result[0].content[0] as { text: string }).text;
    expect(activeWorkspaceText).toContain('skill: "app-builder"');
    expect(activeWorkspaceText).not.toContain('id: "app-builder"');
  });
});

describe("applyRuntimeInjections — minimal mode skips workspace blocks", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
  });

  afterEach(() => {
    if (registeredWorkspace) {
      unregisterConversationWorkspace(registeredWorkspace);
      registeredWorkspace = null;
    }
  });

  test("minimal mode skips workspace top-level context", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
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
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
    });

    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
  });
});
