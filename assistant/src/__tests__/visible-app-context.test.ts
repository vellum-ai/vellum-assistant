/**
 * Tests for `buildVisibleAppContext`, the resolver behind the `visible_app:`
 * turn-context line.
 *
 * The client reports only the id of the app it has on screen; the daemon
 * resolves the name and source directory so the assistant can act on the app
 * without a lookup. A stale or malformed id must degrade to "no app in view"
 * rather than failing the turn.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp, deleteApp } from "../apps/app-store.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  buildVisibleAppContext,
} from "../daemon/conversation-runtime-assembly.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import type { Message } from "../providers/types.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { asConversation } from "./helpers/mock-conversation.js";

// The injector chain is registered by the daemon bootstrap in production; do
// the same here so `applyRuntimeInjections` walks a non-empty chain.
registerDefaultPluginInjectors();

let testDataDir: string;
// Restored after each test so the workspace override never outlives this file:
// leaving it pointed at a directory we just deleted breaks whatever module a
// sibling test file loads next.
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

beforeEach(() => {
  testDataDir = join(
    tmpdir(),
    `vellum-visible-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;
});

afterEach(() => {
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

describe("buildVisibleAppContext", () => {
  test("resolves the app's name and readable slug, without a host path", () => {
    // A workspace app id is an opaque UUID; the slug is the handle a human
    // (or the model) recognizes, so both have to come back.
    const app = createApp({
      name: "Grocery List",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });

    expect(buildVisibleAppContext(app.id)).toEqual({
      appId: app.id,
      name: "Grocery List",
      slug: "grocery-list",
    });
  });

  test("carries no resolved directory, only derivable handles", () => {
    // Only derivable handles ship: a workspace app's directory is the
    // workspace `Root:` joined with the app-builder skill's
    // `data/apps/<slug>/` layout, so no value here may be an absolute path.
    const app = createApp({
      name: "Grocery List",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });

    const context = buildVisibleAppContext(app.id);

    expect(context).not.toBeNull();
    for (const value of Object.values(context ?? {})) {
      expect(value.startsWith("/")).toBe(false);
    }
  });

  test("returns null when no app is in view", () => {
    expect(buildVisibleAppContext(undefined)).toBeNull();
    expect(buildVisibleAppContext("")).toBeNull();
  });

  test("returns null for an app that no longer exists", () => {
    const app = createApp({
      name: "Deleted App",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });
    deleteApp(app.id);

    expect(buildVisibleAppContext(app.id)).toBeNull();
  });

  test("returns null for a traversal-shaped id instead of throwing", () => {
    expect(buildVisibleAppContext("../../etc/passwd")).toBeNull();
  });

  test("resolves a plugin-bundled app, which the viewer can open too", () => {
    const pluginDir = join(getWorkspacePluginsDir(), "acme");
    mkdirSync(join(pluginDir, "apps", "acme-dashboard"), { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "acme", version: "1.0.0" }),
    );
    writeFileSync(
      join(pluginDir, "apps", "acme-dashboard", "index.html"),
      "<h1>Plugin app</h1>",
    );

    expect(buildVisibleAppContext("plugins~acme~acme-dashboard")).toEqual({
      appId: "plugins~acme~acme-dashboard",
      name: "acme-dashboard",
      slug: "acme-dashboard",
      pluginName: "acme",
    });
  });

  test("returns null for a plugin app whose plugin is not installed", () => {
    expect(buildVisibleAppContext("plugins~not-a-plugin~x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the injector chain: the app frozen on the live
// conversation at turn start must reach the rendered `<turn_context>` block.
// ---------------------------------------------------------------------------

describe("visible_app injection", () => {
  const CONVERSATION_ID = "visible-app-injection-conv";

  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "make the header bigger" }],
    },
  ];

  function seedConversation(currentTurnVisibleAppId: string | undefined): void {
    setConversation(
      CONVERSATION_ID,
      asConversation({
        conversationId: CONVERSATION_ID,
        workingDir: "/sandbox",
        workspaceTopLevelContext: "",
        workspaceTopLevelDirty: false,
        surfaceState: new Map(),
        currentTurnVisibleAppId,
        currentTurnTemporalSnapshot: {
          clientTimezone: null,
          timeSinceLastMessage: null,
        },
      }),
    );
  }

  afterEach(() => {
    clearConversations();
  });

  async function injectedText(): Promise<string> {
    const { messages } = await applyRuntimeInjections(baseMessages, {
      conversationId: CONVERSATION_ID,
      requestId: "visible-app-req",
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

  test("renders the frozen visible app inside <turn_context>", async () => {
    const app = createApp({
      name: "Grocery List",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });
    seedConversation(app.id);

    const text = await injectedText();
    expect(text).toContain("<turn_context>");
    expect(text).toContain(`visible_app: "Grocery List" (app_id: "${app.id}"`);
  });

  test("emits no visible_app line when no app was in view", async () => {
    seedConversation(undefined);

    const text = await injectedText();
    expect(text).toContain("<turn_context>");
    expect(text).not.toContain("visible_app:");
  });
});
