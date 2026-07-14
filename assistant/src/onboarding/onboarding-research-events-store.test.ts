import { beforeEach, describe, expect, test } from "bun:test";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { telemetryEvents } from "../persistence/schema/index.js";
import {
  resetOutboxTable,
  setShareAnalytics,
  setShareDiagnostics,
} from "../telemetry/__tests__/outbox-test-harness.js";
import { APP_VERSION } from "../version.js";
import { recordOnboardingResearchEvent } from "./onboarding-research-events-store.js";

const SAMPLE_CLAIMS = [
  {
    claim: "Senior engineer at an AI infra startup",
    confidence: "confident" as const,
    sources: ["https://linkedin.com/in/example"],
  },
  {
    claim: "Based in Boulder, CO",
    confidence: "confident" as const,
    sources: [],
  },
  {
    claim: "Active climber on Mountain Project",
    confidence: "maybe" as const,
    sources: [],
  },
  {
    claim: "Focused on evals",
    confidence: "guessing" as const,
    sources: ["https://github.com/example"],
  },
];

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
    setShareAnalytics(true);
    setShareDiagnostics(true);
    resetOutboxTable();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    setShareAnalytics(false);
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

  test("honors the share_diagnostics opt-out (records nothing) even with analytics consent", () => {
    setShareDiagnostics(false);
    recordOnboardingResearchEvent({
      conversationId: "conv-xyz",
      status: "done",
      claims: SAMPLE_CLAIMS,
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });
    expect(pendingRows()).toHaveLength(0);
  });

  test("honors a stale accepted diagnostics-consent version (records nothing)", () => {
    setShareDiagnostics(true, "2000-01-01");
    recordOnboardingResearchEvent({
      conversationId: "conv-xyz",
      status: "done",
      claims: SAMPLE_CLAIMS,
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
      claims: SAMPLE_CLAIMS,
      suggestions: [
        { suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" },
      ],
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
      // Deterministic on the conversation id (not the row id) so a
      // resume-triggered duplicate report collapses downstream.
      daemon_event_id: "onboarding_research:conv-xyz",
      recorded_at: row.createdAt,
      conversation_id: "conv-xyz",
      status: "done",
      claims: SAMPLE_CLAIMS,
      claim_count: 4,
      claims_confident: 2,
      claims_maybe: 1,
      claims_guessing: 1,
      suggestions: [
        { suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" },
      ],
      suggestion_count: 1,
      plugins: ["marketing-expert"],
      installed_plugins: ["marketing-expert", "web-research"],
      assistant_version: APP_VERSION,
    });
  });

  test("empty claims/suggestions/plugins ship as empty arrays with zeroed counts; daemon_event_id falls back to the row id without a conversation", () => {
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
      daemon_event_id: rows[0]!.id,
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

  test("a resume-triggered duplicate report shares one daemon_event_id per conversation", () => {
    recordOnboardingResearchEvent({
      conversationId: "conv-resume",
      status: "done",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });
    recordOnboardingResearchEvent({
      conversationId: "conv-resume",
      status: "done",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });

    // Two distinct outbox rows (each flush attempt ships independently), but
    // both stamp the SAME wire `daemon_event_id` so downstream analytics
    // collapse the resume-triggered retry onto the original attempt.
    const rows = pendingRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows[0]!.payload.daemon_event_id).toBe(
      "onboarding_research:conv-resume",
    );
    expect(rows[1]!.payload.daemon_event_id).toBe(
      "onboarding_research:conv-resume",
    );
  });

  test("a timeout report gets a fresh id, not the conversation's collapse id, so it can never mask a later genuine success", () => {
    recordOnboardingResearchEvent({
      conversationId: "conv-slow",
      status: "error",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });
    recordOnboardingResearchEvent({
      conversationId: "conv-slow",
      status: "done",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });

    const rows = pendingRows();
    expect(rows).toHaveLength(2);
    const errorRow = rows.find((r) => r.payload.status === "error")!;
    const doneRow = rows.find((r) => r.payload.status === "done")!;
    expect(errorRow.payload.daemon_event_id).toBe(errorRow.id);
    expect(doneRow.payload.daemon_event_id).toBe(
      "onboarding_research:conv-slow",
    );
  });
});
