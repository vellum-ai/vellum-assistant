import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Usage-data collection is enabled for these tests.
mock.module("../../../../../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

import type { SkillToolEntry } from "../../../../../config/skills.js";
import { markActivationSession } from "../../../../../memory/activation-session-store.js";
import { getDb } from "../../../../../memory/db-connection.js";
import { initializeDb } from "../../../../../memory/db-init.js";
import { queryUnreportedOnboardingEvents } from "../../../../../memory/onboarding-events-store.js";
import {
  activationSessions,
  onboardingEvents,
} from "../../../../../memory/schema.js";
import { createSkillTool } from "../../../../../tools/skills/skill-tool-factory.js";
import type { ToolContext } from "../../../../../tools/types.js";
import { run } from "../emit-activation-event.js";

// Skill root is three levels up from this test file:
// activation/tools/__tests__/ → activation/.
const SKILL_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

initializeDb();

function resetTables(): void {
  getDb().delete(onboardingEvents).run();
  getDb().delete(activationSessions).run();
}

function ctx(conversationId: string): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId,
    trustClass: "guardian",
  };
}

describe("emit_activation_event tool", () => {
  beforeEach(resetTables);

  test("records one row for a valid step in a marked rail session", async () => {
    markActivationSession("conv-1");
    const result = await run(
      { step_name: "activation_moment_2_complete" },
      ctx("conv-1"),
    );
    expect(result.isError).toBe(false);

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
    expect(rows[0]!.sessionId).toBe("conv-1");
  });

  test("rejects the daemon-owned msg_5 step: non-error result, no row", async () => {
    markActivationSession("conv-2");
    const result = await run(
      { step_name: "activation_msg_5_sent" },
      ctx("conv-2"),
    );
    expect(result.isError).toBe(false);
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("malformed/unknown input: non-error result, no row", async () => {
    markActivationSession("conv-3");

    const unknown = await run({ step_name: "bogus" }, ctx("conv-3"));
    expect(unknown.isError).toBe(false);

    const missing = await run({}, ctx("conv-3"));
    expect(missing.isError).toBe(false);

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });
});

// The direct-run tests above bypass the manifest schema validation that
// `createSkillTool` runs before `run()`. These exercise the PRODUCTION path:
// the model-facing tool built from the real TOOLS.json manifest. They guard
// against `step_name` becoming `required` again, which would error the turn on
// a malformed emit and violate the never-error contract.
describe("emit_activation_event via createSkillTool (production path)", () => {
  beforeEach(resetTables);

  function manifestEntry(): SkillToolEntry {
    const manifest = JSON.parse(
      readFileSync(join(SKILL_DIR, "TOOLS.json"), "utf-8"),
    ) as { tools: SkillToolEntry[] };
    const entry = manifest.tools.find(
      (t) => t.name === "emit_activation_event",
    );
    expect(entry).toBeDefined();
    return entry!;
  }

  // bundled: true routes to the pre-imported registry; no version hash so the
  // runner skips the integrity check.
  function makeProductionTool() {
    return createSkillTool(manifestEntry(), SKILL_DIR, "", true);
  }

  test("manifest no longer marks step_name required", () => {
    const schema = manifestEntry().input_schema as { required?: unknown };
    expect(schema.required ?? []).not.toContain("step_name");
  });

  test("missing step_name: non-error result, no row, no validation error", async () => {
    markActivationSession("conv-prod-1");
    const tool = makeProductionTool();

    const result = await tool.execute({}, ctx("conv-prod-1"));

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Invalid input");
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("valid step records a row through the production path", async () => {
    markActivationSession("conv-prod-2");
    const tool = makeProductionTool();

    const result = await tool.execute(
      { step_name: "activation_moment_1_complete" },
      ctx("conv-prod-2"),
    );

    expect(result.isError).toBe(false);
    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_1_complete");
  });
});
