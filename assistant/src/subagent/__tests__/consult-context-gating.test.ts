/**
 * Personal-memory gating for the advisor context pack: NOW.md must only reach
 * the advisor when the turn's trust admits personal memory and the
 * scratchpad-injection toggle is on, the same policy the runtime memory
 * injectors apply. Without it, a low-risk advisor consult on a
 * remote/trusted-contact turn could forward private content the main agent
 * would never receive.
 *
 * Mocks are isolated to this file (the test runner runs each file in its own
 * process), so the broad module stubs here don't leak into other suites.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let personalAllowed = false;
let scratchpadEnabled = true;
let gateArg: unknown = null;

mock.module("../../daemon/trust-context.js", () => ({
  isPersonalMemoryAllowed: (trust: unknown) => {
    gateArg = trust;
    return personalAllowed;
  },
}));
mock.module("../../daemon/now-scratchpad.js", () => ({
  readNowScratchpad: () => "NOW-CONTENT",
}));
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      retrieval: { scratchpadInjection: { enabled: scratchpadEnabled } },
    },
    llm: {},
  }),
}));
// Keep every other section empty so the assertions isolate NOW.md.
mock.module("../../daemon/conversation-workspace.js", () => ({
  resolveWorkspaceTopLevelContext: () => null,
}));
mock.module("../../daemon/conversation-runtime-assembly.js", () => ({
  buildActiveDocuments: () => null,
}));
mock.module("../../config/skills.js", () => ({
  loadSkillCatalog: () => [],
}));

const { buildAdvisorContext } = await import("../consult-context.js");

const sources = {
  conversationId: "c1",
  // A path that does not exist, so the workspace-tree section stays empty and
  // the assertions isolate the gated surfaces.
  workingDir: "/tmp/does-not-exist-consult-gating",
  // A non-guardian per-turn snapshot: the case the live-state read could have
  // wrongly elevated.
  trustClass: "unknown" as const,
  allowedToolNames: new Set<string>(),
};

beforeEach(() => {
  personalAllowed = false;
  scratchpadEnabled = true;
  gateArg = null;
});

describe("advisor context pack: personal-memory gating", () => {
  test("withholds NOW.md when personal memory is disallowed", async () => {
    personalAllowed = false;
    const ctx = (await buildAdvisorContext(sources)) ?? "";
    expect(ctx).not.toContain("NOW-CONTENT");
  });

  test("includes NOW.md when allowed and the scratchpad toggle is on", async () => {
    personalAllowed = true;
    scratchpadEnabled = true;
    const ctx = await buildAdvisorContext(sources);
    expect(ctx).toContain("NOW-CONTENT");
  });

  test("withholds NOW.md when the scratchpad toggle is off", async () => {
    personalAllowed = true;
    scratchpadEnabled = false;
    const ctx = (await buildAdvisorContext(sources)) ?? "";
    expect(ctx).not.toContain("NOW-CONTENT");
  });

  test("feeds the gate the per-turn trust snapshot, not live conversation state", async () => {
    personalAllowed = true;
    await buildAdvisorContext(sources);
    // The gate must see exactly the class threaded from the ToolContext
    // snapshot, so a concurrent live-trust change cannot elevate this
    // invocation.
    expect(gateArg).toEqual({ trustClass: "unknown" });
  });
});
