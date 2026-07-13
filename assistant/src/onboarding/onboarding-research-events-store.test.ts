import { beforeEach, describe, expect, mock, test } from "bun:test";

let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { telemetryEvents } from "../persistence/schema/index.js";
import { APP_VERSION } from "../version.js";
import { recordOnboardingResearchEvent } from "./onboarding-research-events-store.js";

await initializeDb();

function pendingRows(): Array<{
  id: string;
  name: string;
  createdAt: number;
  conversationId: string | null;
  payload: Record<string, unknown>;
}> {
  return getTelemetryDb()!
    .select()
    .from(telemetryEvents)
    .all()
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
}

describe("onboarding-research-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    getTelemetryDb()!.delete(telemetryEvents).run();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    recordOnboardingResearchEvent({
      conversationId: "conv-xyz",
      status: "done",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });
    expect(pendingRows()).toHaveLength(0);
  });

  test("record writes the full wire payload into the outbox, with confidence-tier counts", () => {
    recordOnboardingResearchEvent({
      conversationId: "conv-xyz",
      status: "done",
      claims: [
        { claim: "Senior engineer at an AI infra startup", confidence: "confident", sources: ["https://linkedin.com/in/example"] },
        { claim: "Based in Boulder, CO", confidence: "confident", sources: [] },
        { claim: "Active climber on Mountain Project", confidence: "maybe", sources: [] },
        { claim: "Focused on evals", confidence: "guessing", sources: ["https://github.com/example"] },
      ],
      suggestions: [{ suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" }],
      plugins: ["marketing-expert"],
      installedPlugins: ["marketing-expert", "web-research"],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("onboarding_research");
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    // Dedicated column, so conversation deletion redacts pending rows via an
    // indexed delete.
    expect(row.conversationId).toBe("conv-xyz");
    expect(row.payload).toEqual({
      type: "onboarding_research",
      daemon_event_id: row.id,
      recorded_at: row.createdAt,
      conversation_id: "conv-xyz",
      status: "done",
      claims: [
        { claim: "Senior engineer at an AI infra startup", confidence: "confident", sources: ["https://linkedin.com/in/example"] },
        { claim: "Based in Boulder, CO", confidence: "confident", sources: [] },
        { claim: "Active climber on Mountain Project", confidence: "maybe", sources: [] },
        { claim: "Focused on evals", confidence: "guessing", sources: ["https://github.com/example"] },
      ],
      claim_count: 4,
      claims_confident: 2,
      claims_maybe: 1,
      claims_guessing: 1,
      suggestions: [{ suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" }],
      suggestion_count: 1,
      plugins: ["marketing-expert"],
      installed_plugins: ["marketing-expert", "web-research"],
      assistant_version: APP_VERSION,
    });
  });

  test("empty claims/suggestions/plugins ship as empty arrays with zeroed counts", () => {
    recordOnboardingResearchEvent({
      conversationId: null,
      status: "error",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBeNull();
    expect(rows[0]!.payload).toMatchObject({
      status: "error",
      claims: [],
      claim_count: 0,
      claims_confident: 0,
      claims_maybe: 0,
      claims_guessing: 0,
      suggestions: [],
      suggestion_count: 0,
      plugins: [],
      installed_plugins: [],
    });
  });
});
