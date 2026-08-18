/**
 * Tests for the document post-execution hooks that publish a documents-changed
 * broadcast so client asset lists and the Library refresh after a mutation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  DOCUMENT_EDIT_TOOL_NAMES,
  DOCUMENT_MUTATION_TOOL_NAMES,
  REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES,
} from "../api/constants/document-tools.js";
import { createMockLoggerModule } from "./helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks. Must be set up before importing the module under test.
// ---------------------------------------------------------------------------

const mockPublishDocumentsChanged = mock(() => {});
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishAppsChanged: mock(() => {}),
  publishDocumentsChanged: mockPublishDocumentsChanged,
}));

mock.module("../util/logger.js", () => createMockLoggerModule());

// Stub the transitive imports so the module graph under test stops at
// tool-side-effects.ts and never reaches the real sync publisher.
mock.module("../media/app-icon-generator.js", () => ({
  generateAppIcon: mock(() => Promise.resolve()),
}));
mock.module("../apps/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => ""),
  getAppsDir: mock(() => ""),
  resolveAppIdFromPath: mock(() => null),
  resolveAppIdByDirName: mock(() => null),
  resolveAppDir: mock(() => ({ dirName: "", dirPath: "" })),
  slugify: mock((s: string) => s),
  validateDirName: mock(() => {}),
  generateAppDirName: mock(() => ""),
  listApps: mock(() => []),
  createApp: mock(() => ({})),
  updateApp: mock(() => {}),
  deleteApp: mock(() => {}),
  getAppPreview: mock(() => null),
  createAppRecord: mock(() => ({})),
  getAppRecord: mock(() => null),
  queryAppRecords: mock(() => []),
  updateAppRecord: mock(() => {}),
  deleteAppRecord: mock(() => {}),
  listAppFiles: mock(() => []),
  appFileExists: mock(() => false),
  readAppFile: mock(() => ""),
  writeAppFile: mock(() => {}),
  editAppFile: mock(() => ({})),
  inlineDistAssets: mock((_: unknown, html: string) => html),
  addAppConversationId: mock(() => false),
  linkAppToConversationLineage: mock(() => {}),
}));
mock.module("../bundler/app-compiler.js", () => ({
  compileApp: mock(() => Promise.resolve({ ok: true })),
}));
mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));
mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
}));
mock.module("../daemon/doordash-steps.js", () => ({
  isDoordashCommand: mock(() => false),
  updateDoordashProgress: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks. The dynamic import ensures the mock.module() calls above
// are registered before tool-side-effects.ts evaluates its top-level imports.
// ---------------------------------------------------------------------------

import type { SideEffectContext } from "../daemon/tool-side-effects.js";

const { runPostExecutionSideEffects } =
  await import("../daemon/tool-side-effects.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummySideEffectCtx = {
  ctx: {} as SideEffectContext["ctx"],
} satisfies SideEffectContext;

const READ_ONLY_TOOLS = [
  "document_read",
  "document_list",
  "document_find",
  "document_open",
];

// The content is deliberately not JSON: the hook fires on the executed tool
// name alone and must never depend on the shape of the LLM-facing result.
async function runTool(name: string, isError = false): Promise<void> {
  await runPostExecutionSideEffects(
    name,
    { surface_id: "doc-1" },
    { content: "Document saved.", isError },
    dummySideEffectCtx,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("document hooks: documents-changed broadcast", () => {
  beforeEach(() => {
    mockPublishDocumentsChanged.mockReset();
  });

  for (const toolName of DOCUMENT_MUTATION_TOOL_NAMES) {
    test(`${toolName} publishes exactly one documents change`, async () => {
      await runTool(toolName);
      expect(mockPublishDocumentsChanged).toHaveBeenCalledTimes(1);
    });
  }

  for (const toolName of READ_ONLY_TOOLS) {
    test(`${toolName} publishes no documents change`, async () => {
      await runTool(toolName);
      expect(mockPublishDocumentsChanged).not.toHaveBeenCalled();
    });
  }

  test("a failed mutation publishes no documents change", async () => {
    await runTool("document_update", true);
    expect(mockPublishDocumentsChanged).not.toHaveBeenCalled();
  });

  test("two mutations in one turn publish once each", async () => {
    await runTool("document_update");
    await runTool("document_replace_text");
    expect(mockPublishDocumentsChanged).toHaveBeenCalledTimes(2);
  });
});

// The daemon hooks every mutating tool, while the web transcript anchors its
// changed-document chips on the reopenable subset and its inline-preview
// bookkeeping on the edit subset. Pinning all three keeps a new entry in
// `DOCUMENT_MUTATION_TOOLS` from silently landing in the wrong subsets.
describe("document mutation tool metadata", () => {
  test("the daemon hooks every mutating document tool", () => {
    expect([...DOCUMENT_MUTATION_TOOL_NAMES]).toEqual([
      "document_create",
      "document_update",
      "document_replace_text",
      "document_delete",
    ]);
  });

  test("the reopenable subset drops document_delete and keeps the rest", () => {
    expect([...REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES]).toEqual([
      "document_create",
      "document_update",
      "document_replace_text",
    ]);
  });

  test("the edit subset is exactly the two write-into-existing tools", () => {
    expect([...DOCUMENT_EDIT_TOOL_NAMES]).toEqual([
      "document_update",
      "document_replace_text",
    ]);
  });
});
