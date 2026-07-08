import { afterEach, describe, expect, test } from "bun:test";

import { createApp } from "../apps/app-store.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { applyRuntimeInjections } from "../daemon/conversation-runtime-assembly.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import type { Message } from "../providers/types.js";

// Populate the injector registry with the default plugins' injectors the way
// bootstrap does in production, so `applyRuntimeInjections` walks a non-empty
// chain. This suite has no `beforeEach`, so registering at module load (before
// any test runs) is sufficient.
registerDefaultPluginInjectors();

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

// Register the fallback conversation in the live registry so the runtime
// injectors resolve their blocks from it (the orchestrator no longer threads
// workspace or active-surface content as options).
function registerFallbackConversation(fields: Record<string, unknown>): void {
  setConversation(FALLBACK_CONVERSATION_ID, {
    conversationId: FALLBACK_CONVERSATION_ID,
    workingDir: "/sandbox",
    // Non-dirty empty workspace by default so the workspace-context injector
    // skips both the filesystem rescan and the DB refresh unless a test
    // explicitly seeds a block via `workspaceTopLevelContext`.
    workspaceTopLevelContext: "",
    workspaceTopLevelDirty: false,
    ...fields,
  } as never);
}

// Seed the live conversation registry with a pre-rendered top-level block. The
// cache is non-dirty with non-null content, so `resolveWorkspaceTopLevelContext`
// returns it verbatim without rescanning the filesystem.
function seedWorkspaceContext(text: string): void {
  registerFallbackConversation({
    workspaceTopLevelContext: text,
    workspaceTopLevelDirty: false,
  });
}

// Build the conversation surface-state map that `buildActiveSurfaceContext`
// reads to render the `<active_workspace>` block.
function makeSurfaceState(
  surfaceId: string,
  data: SurfaceData,
): Map<string, { surfaceType: SurfaceType; data: SurfaceData }> {
  return new Map([[surfaceId, { surfaceType: "dynamic_page", data }]]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleContext =
  "<workspace>\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace>";

// The workspace-context default injector emits the workspace block as a
// `prepend-user-tail` placement during `applyRuntimeInjections`. It sources
// the rendered block from the per-conversation workspace registry and
// (re)injects only when the block is absent from the working messages, so the
// suite seeds the registry and exercises that end-to-end path.

describe("applyRuntimeInjections — workspace top-level context", () => {
  afterEach(() => {
    clearConversations();
  });

  test("injects workspace context when registered", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toBe("Hello");
  });

  test("does not inject when no workspace context is registered", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
  });

  test("does not re-inject when the workspace block is already present", async () => {
    // GIVEN the registry holds a workspace block AND the working messages
    // already carry that block (a normal cached turn, post-injection).
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg(sampleContext), userMsg("Hello")];

    // WHEN injections are applied
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    // THEN presence detection skips the block to keep the prefix stable.
    expect(result).toHaveLength(2);
    expect(result[1].content).toHaveLength(1);
    expect((result[1].content[0] as { text: string }).text).toBe("Hello");
  });

  test("workspace context appears before active surface context in content", async () => {
    registerFallbackConversation({
      workspaceTopLevelContext: sampleContext,
      workspaceTopLevelDirty: false,
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
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
    const app = createApp({
      name: "Example App",
      schemaJson: "{}",
      htmlDefinition: "<div>test</div>",
    });
    registerFallbackConversation({
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", {
        html: "<div>test</div>",
        appId: app.id,
      }),
    });
    const messages: Message[] = [userMsg("Edit this app")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    const activeWorkspaceText = (result[0].content[0] as { text: string }).text;
    expect(activeWorkspaceText).toContain('skill: "app-builder"');
    expect(activeWorkspaceText).not.toContain('id: "app-builder"');
  });
});

describe("applyRuntimeInjections — minimal mode skips workspace blocks", () => {
  afterEach(() => {
    clearConversations();
  });

  test("minimal mode skips workspace top-level context", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("minimal mode skips active surface context", async () => {
    registerFallbackConversation({
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("full mode (default) still includes workspace blocks", async () => {
    registerFallbackConversation({
      workspaceTopLevelContext: sampleContext,
      workspaceTopLevelDirty: false,
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
  });
});
