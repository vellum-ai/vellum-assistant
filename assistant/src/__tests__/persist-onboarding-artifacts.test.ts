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
  });

  afterEach(() => {
    for (const name of ["IDENTITY.md", "USER.md"]) {
      const p = workspacePath(name);
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  test("seeds IDENTITY.md with assistant name when file does not exist", () => {
    persistOnboardingArtifacts({
      tools: ["slack"],
      tasks: ["email"],
      tone: "balanced",
      assistantName: "Nova",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe("# Identity\n\n- Name: Nova\n");
  });

  test("seeds USER.md with user name when file does not exist", () => {
    persistOnboardingArtifacts({
      tools: ["slack"],
      tasks: ["email"],
      tone: "balanced",
      userName: "Alex",
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toBe("# User\n\n- Name: Alex\n");
  });

  test("seeds both IDENTITY.md and USER.md when both names are provided", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "professional",
      userName: "Alex",
      assistantName: "Pax",
    });

    expect(readFileSync(workspacePath("IDENTITY.md"), "utf-8")).toBe(
      "# Identity\n\n- Name: Pax\n",
    );
    expect(readFileSync(workspacePath("USER.md"), "utf-8")).toBe(
      "# User\n\n- Name: Alex\n",
    );
  });

  test("does not overwrite existing IDENTITY.md", () => {
    writeFileSync(
      workspacePath("IDENTITY.md"),
      "# Identity\n\n- Name: Existing\n",
    );

    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "casual",
      assistantName: "NewName",
    });

    const content = readFileSync(workspacePath("IDENTITY.md"), "utf-8");
    expect(content).toBe("# Identity\n\n- Name: Existing\n");
  });

  test("does not overwrite existing USER.md", () => {
    writeFileSync(workspacePath("USER.md"), "# User\n\n- Name: Existing\n");

    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "casual",
      userName: "NewUser",
    });

    const content = readFileSync(workspacePath("USER.md"), "utf-8");
    expect(content).toBe("# User\n\n- Name: Existing\n");
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

  test("skips USER.md when userName is missing", () => {
    persistOnboardingArtifacts({
      tools: ["notion"],
      tasks: ["project-management"],
      tone: "balanced",
      assistantName: "Nova",
    });

    expect(existsSync(workspacePath("USER.md"))).toBe(false);
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

  test("skips USER.md when userName is whitespace-only", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "balanced",
      userName: "  ",
    });

    expect(existsSync(workspacePath("USER.md"))).toBe(false);
  });

  test("trims whitespace from names before writing", () => {
    persistOnboardingArtifacts({
      tools: [],
      tasks: [],
      tone: "balanced",
      userName: "  Alex  ",
      assistantName: "  Nova  ",
    });

    expect(readFileSync(workspacePath("IDENTITY.md"), "utf-8")).toBe(
      "# Identity\n\n- Name: Nova\n",
    );
    expect(readFileSync(workspacePath("USER.md"), "utf-8")).toBe(
      "# User\n\n- Name: Alex\n",
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
});
