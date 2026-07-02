/**
 * Early activation-session marking.
 *
 * The agent loop resolves TOOLS before the SYSTEM PROMPT, so the activation
 * marker must be written before tool resolution on the first activation-rail
 * turn — otherwise the `activation` skill is not preactivated and the emit
 * handler is gated off for the very turn that emits Moment 1. The marking lives
 * in `applyBootstrapTemplate`, which is called from `setOnboardingContext` (the
 * earliest point the conversation knows its bootstrap selection) as well as
 * from `buildSystemPrompt` as an idempotent backstop.
 *
 * These tests exercise `applyBootstrapTemplate` directly against the real
 * DB-backed `isActivationSession` and a real workspace BOOTSTRAP.md, proving the
 * marker is set INDEPENDENT of any `buildSystemPrompt` render.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { applyBootstrapTemplate } = await import("../prompts/system-prompt.js");
const { isActivationSession } =
  await import("../plugins/defaults/memory/activation-session-store.js");
const { ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE } =
  await import("../telemetry/activation-funnel.js");
const { getDb } = await import("../persistence/db-connection.js");
const { initializeDb } = await import("../persistence/db-init.js");
const { activationSessions } = await import("../persistence/schema/index.js");

await initializeDb();

/** Seed the workspace BOOTSTRAP.md with the unmodified generic template so the
 *  one-shot reseed inside `applyBootstrapTemplate` fires. */
function seedGenericBootstrap(): void {
  mkdirSync(TEST_DIR, { recursive: true });
  const generic = readFileSync(
    join(import.meta.dirname, "..", "prompts", "templates", "BOOTSTRAP.md"),
    "utf-8",
  );
  writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), generic, "utf-8");
}

describe("applyBootstrapTemplate — early activation marking", () => {
  beforeEach(() => {
    getDb().delete(activationSessions).run();
  });

  test("marks the conversation when the activation-rail template is applied", () => {
    seedGenericBootstrap();
    expect(isActivationSession("rail-conv")).toBe(false);

    // No buildSystemPrompt call — marking must happen here.
    applyBootstrapTemplate(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE, "rail-conv");

    expect(isActivationSession("rail-conv")).toBe(true);
  });

  test("does not mark when a non-rail bootstrap template is applied", () => {
    seedGenericBootstrap();

    applyBootstrapTemplate("BOOTSTRAP-REFERENCE.md", "non-rail-conv");

    expect(isActivationSession("non-rail-conv")).toBe(false);
  });

  test("does not mark when no conversation id is supplied", () => {
    seedGenericBootstrap();

    applyBootstrapTemplate(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);

    // Nothing to assert by id; confirm the table stayed empty.
    const rows = getDb().select().from(activationSessions).all();
    expect(rows.length).toBe(0);
  });

  test("does not mark when BOOTSTRAP.md is customized to something else", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // A user-customized BOOTSTRAP.md is neither the generic template (so the
    // reseed no-ops) nor the activation-rail template — the rail is not active.
    writeFileSync(
      join(TEST_DIR, "BOOTSTRAP.md"),
      "# My custom bootstrap\n",
      "utf-8",
    );

    applyBootstrapTemplate(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE, "custom-conv");

    expect(isActivationSession("custom-conv")).toBe(false);
  });

  test("marks idempotently when BOOTSTRAP.md already holds the rail template", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Simulate a later turn: BOOTSTRAP.md already holds the rail template, so
    // the reseed no-ops but marking still fires (idempotent backstop).
    copyFileSync(
      join(
        import.meta.dirname,
        "..",
        "prompts",
        "templates",
        ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
      ),
      join(TEST_DIR, "BOOTSTRAP.md"),
    );

    applyBootstrapTemplate(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE, "rail-conv-2");
    applyBootstrapTemplate(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE, "rail-conv-2");

    expect(isActivationSession("rail-conv-2")).toBe(true);
  });
});
