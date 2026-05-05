import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

let writeRelationshipStateCalled = false;
let sidecarPayload: unknown = null;
let writeOnboardingSectionPayload: unknown = null;

mock.module("../prompts/normalize-onboarding.js", () => ({
  normalizeOnboardingContext: (ctx: unknown) => ctx,
}));

mock.module("../prompts/persona-resolver.js", () => ({
  writeOnboardingSection: (payload: unknown) => {
    writeOnboardingSectionPayload = payload;
  },
  resolveGuardianPersonaPath: () => join(TEST_DIR, "users", "guardian.md"),
  resolveGuardianPersona: () => null,
  resolveGuardianPersonaStrict: () => null,
  resolveUserPersona: () => null,
  resolveChannelPersona: () => null,
  resolvePersonaContext: () => ({
    userPersona: null,
    userSlug: null,
    channelPersona: null,
  }),
  resolveUserSlug: () => null,
  ensureGuardianPersonaFile: () => {},
  isGuardianPersonaCustomized: () => false,
  GUARDIAN_PERSONA_TEMPLATE: "",
}));

mock.module("../home/relationship-state-writer.js", () => ({
  RELATIONSHIP_STATE_FILENAME: "relationship-state.json",
  ONBOARDING_SIDECAR_FILENAME: "onboarding-context.json",
  getRelationshipStatePath: () =>
    join(TEST_DIR, "data", "relationship-state.json"),
  getOnboardingSidecarPath: () =>
    join(TEST_DIR, "data", "onboarding-context.json"),
  writeOnboardingSidecar: (payload: unknown) => {
    sidecarPayload = payload;
  },
  computeRelationshipState: () =>
    Promise.resolve({ facts: [], userName: null, assistantName: null }),
  writeRelationshipState: () => {
    writeRelationshipStateCalled = true;
    return Promise.resolve();
  },
  backfillRelationshipStateIfMissing: () => Promise.resolve(),
}));

const { persistOnboardingArtifacts } =
  await import("../runtime/routes/conversation-routes.js");

function workspacePath(file: string): string {
  return join(TEST_DIR, file);
}

describe("persistOnboardingArtifacts", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeRelationshipStateCalled = false;
    sidecarPayload = null;
    writeOnboardingSectionPayload = null;
  });

  afterEach(() => {
    const p = workspacePath("IDENTITY.md");
    if (existsSync(p)) rmSync(p, { force: true });
  });

  test("seeds IDENTITY.md with assistant name when file does not exist", () => {
    persistOnboardingArtifacts({
      tools: ["slack"],
      tasks: ["email"],
      tone: "balanced",
      assistantName: "Nova",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe("# Identity\n\n- **Name:** Nova\n");
  });

  test("seeds IDENTITY.md when both names are provided", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "professional",
      userName: "Alex",
      assistantName: "Pax",
    });

    expect(readFileSync(workspacePath("IDENTITY.md"), "utf-8")).toBe(
      "# Identity\n\n- **Name:** Pax\n",
    );
  });

  test("updates Name field in existing IDENTITY.md template", () => {
    writeFileSync(
      workspacePath("IDENTITY.md"),
      "# Identity\n\n- **Name:** _(not yet chosen)_\n- **Role:** _(not yet established)_\n",
    );

    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "casual",
      assistantName: "NewName",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe(
      "# Identity\n\n- **Name:** NewName\n- **Role:** _(not yet established)_\n",
    );
  });

  test("updates old-format Name field in existing IDENTITY.md", () => {
    writeFileSync(
      workspacePath("IDENTITY.md"),
      "# Identity\n\n- Name: OldFormat\n",
    );

    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "casual",
      assistantName: "NewName",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe("# Identity\n\n- **Name:** NewName\n");
  });

  test("does not touch existing file without Name field", () => {
    writeFileSync(
      workspacePath("IDENTITY.md"),
      "# Identity\n\nCustom content here\n",
    );

    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "casual",
      assistantName: "NewName",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe("# Identity\n\nCustom content here\n");
  });

  test("skips IDENTITY.md when assistantName is missing", () => {
    persistOnboardingArtifacts({
      tools: ["notion"],
      tasks: ["project-management"],
      tone: "balanced",
      userName: "Alex",
    });

    expect(existsSync(workspacePath("IDENTITY.md"))).toBe(false);
  });

  test("skips IDENTITY.md when assistantName is whitespace-only", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "balanced",
      assistantName: "   ",
    });

    expect(existsSync(workspacePath("IDENTITY.md"))).toBe(false);
  });

  test("trims whitespace from assistantName before writing", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "balanced",
      assistantName: "  Nova  ",
    });

    expect(readFileSync(workspacePath("IDENTITY.md"), "utf-8")).toBe(
      "# Identity\n\n- **Name:** Nova\n",
    );
  });

  test("passes onboarding payload to writeOnboardingSidecar", () => {
    const payload = {
      tools: ["slack", "linear"],
      tasks: ["code-building", "writing"],
      tone: "professional",
      userName: "Alex",
      assistantName: "Nova",
    };

    persistOnboardingArtifacts(payload);

    expect(sidecarPayload).toEqual(payload);
  });

  test("triggers writeRelationshipState fire-and-forget", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "balanced",
    });

    expect(writeRelationshipStateCalled).toBe(true);
  });

  test("calls writeOnboardingSection with normalized data", () => {
    const payload = {
      tools: ["slack", "linear"],
      tasks: ["code-building", "writing"],
      tone: "professional",
      userName: "Alex",
      assistantName: "Nova",
    };

    persistOnboardingArtifacts(payload);

    expect(writeOnboardingSectionPayload).toEqual(payload);
  });
});
