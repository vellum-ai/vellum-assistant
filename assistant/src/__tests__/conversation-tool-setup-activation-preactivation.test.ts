/**
 * Cohort-scoped preactivation of the `activation` skill.
 *
 * The activation rail asks the model to emit milestone events via
 * `emit_activation_event`, which lives in the `activation` bundled skill. That
 * tool is only registered for a turn when its skill is preactivated, so the
 * skill must be preactivated automatically for activation-rail conversations —
 * but NOT product-wide (it would leak the tool into every conversation).
 *
 * These tests assert the cohort scoping directly against the real DB-backed
 * `markActivationSession`/`isActivationSession` so a marked conversation gets
 * `activation` in its effective preactivated set and an unmarked one does not.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { computeEffectivePreactivatedSkillIds } from "../daemon/conversation-tool-setup.js";
import { markActivationSession } from "../memory/activation-session-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { activationSessions } from "../memory/schema.js";

initializeDb();

describe("computeEffectivePreactivatedSkillIds — activation cohort scoping", () => {
  beforeEach(() => {
    getDb().delete(activationSessions).run();
  });

  test("marked activation conversation includes the activation skill", () => {
    markActivationSession("rail-conv");

    const ids = computeEffectivePreactivatedSkillIds({
      conversationId: "rail-conv",
    });

    expect(ids).toContain("activation");
    // Global defaults are still present.
    expect(ids).toContain("tasks");
    expect(ids).toContain("notifications");
    expect(ids).toContain("subagent");
  });

  test("non-activation conversation does NOT include the activation skill", () => {
    const ids = computeEffectivePreactivatedSkillIds({
      conversationId: "regular-conv",
    });

    expect(ids).not.toContain("activation");
    // Global defaults remain.
    expect(ids).toContain("tasks");
  });

  test("missing conversation id does not include the activation skill", () => {
    const ids = computeEffectivePreactivatedSkillIds({});

    expect(ids).not.toContain("activation");
  });

  test("conversation-explicit preactivated ids are preserved alongside cohort scoping", () => {
    markActivationSession("rail-conv-2");

    const ids = computeEffectivePreactivatedSkillIds({
      conversationId: "rail-conv-2",
      preactivatedSkillIds: ["guardian-verify-setup"],
    });

    expect(ids).toContain("guardian-verify-setup");
    expect(ids).toContain("activation");
  });
});
