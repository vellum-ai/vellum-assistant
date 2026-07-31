/**
 * Tests for `buildActiveAppContext`, the resolver behind the `active_app:`
 * turn-context line.
 *
 * The client reports only the id of the app it has on screen; the daemon
 * resolves the name and source directory so the assistant can act on the app
 * without a lookup. A stale or malformed id must degrade to "no app in view"
 * rather than failing the turn.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp, deleteApp, getAppDirPath } from "../apps/app-store.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  buildActiveAppContext,
} from "../daemon/conversation-runtime-assembly.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import type { Message } from "../providers/types.js";

// The injector chain is registered by the daemon bootstrap in production; do
// the same here so `applyRuntimeInjections` walks a non-empty chain.
registerDefaultPluginInjectors();

let testDataDir: string;

beforeEach(() => {
  testDataDir = join(
    tmpdir(),
    `vellum-active-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;
});

afterEach(() => {
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

describe("buildActiveAppContext", () => {
  test("resolves the app's name and source directory", () => {
    const app = createApp({
      name: "Grocery List",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });

    expect(buildActiveAppContext(app.id)).toEqual({
      appId: app.id,
      name: "Grocery List",
      sourceDir: getAppDirPath(app.id),
    });
  });

  test("returns null when no app is in view", () => {
    expect(buildActiveAppContext(undefined)).toBeNull();
    expect(buildActiveAppContext("")).toBeNull();
  });

  test("returns null for an app that no longer exists", () => {
    const app = createApp({
      name: "Deleted App",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });
    deleteApp(app.id);

    expect(buildActiveAppContext(app.id)).toBeNull();
  });

  test("returns null for a traversal-shaped id instead of throwing", () => {
    expect(buildActiveAppContext("../../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the injector chain: the app frozen on the live
// conversation at turn start must reach the rendered `<turn_context>` block.
// ---------------------------------------------------------------------------

describe("active_app injection", () => {
  const CONVERSATION_ID = "active-app-injection-conv";

  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "make the header bigger" }],
    },
  ];

  function seedConversation(currentTurnActiveAppId: string | undefined): void {
    setConversation(CONVERSATION_ID, {
      conversationId: CONVERSATION_ID,
      workingDir: "/sandbox",
      workspaceTopLevelContext: "",
      workspaceTopLevelDirty: false,
      surfaceState: new Map(),
      currentTurnActiveAppId,
      currentTurnTemporalSnapshot: { clientTimezone: null },
    } as never);
  }

  afterEach(() => {
    clearConversations();
  });

  async function injectedText(): Promise<string> {
    const { messages } = await applyRuntimeInjections(baseMessages, {
      conversationId: CONVERSATION_ID,
      requestId: "active-app-req",
      turnIndex: 0,
      trust: {
        sourceChannel: "vellum" as const,
        trustClass: "guardian" as const,
      },
    });
    return messages[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  test("renders the frozen active app inside <turn_context>", async () => {
    const app = createApp({
      name: "Grocery List",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });
    seedConversation(app.id);

    const text = await injectedText();
    expect(text).toContain("<turn_context>");
    expect(text).toContain(`active_app: "Grocery List" (app_id: "${app.id}"`);
  });

  test("emits no active_app line when no app was in view", async () => {
    seedConversation(undefined);

    const text = await injectedText();
    expect(text).toContain("<turn_context>");
    expect(text).not.toContain("active_app:");
  });
});
