/**
 * Tests for the catalog filter that decides which plugins onboarding surfaces.
 *
 * The hard rule: only Vellum-hosted (first-party, reviewed) plugins are ever
 * offered or installed during onboarding — never third-party/external
 * marketplace repos — minus a couple of Vellum-owned infra/meta plugins.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveResearchCompletionStatus,
  resolveOnboardingPluginInstalls,
  selectRecommendableCapabilities,
  shouldArchiveCompletedResearchConversation,
  shouldSettleResearchPoll,
} from "@/domains/onboarding/research-runner";

type Match = Parameters<typeof selectRecommendableCapabilities>[0][number];

function match(
  name: string,
  repo: string,
  description?: string,
): Match {
  return {
    name,
    path: `github:${repo}@abc123`,
    category: null,
    ...(description ? { description } : {}),
    source: { kind: "github", repo, ref: "abc123" },
  };
}

describe("selectRecommendableCapabilities", () => {
  test("keeps vellum-hosted plugins and drops external-owner ones", () => {
    const { capabilities, validNames } = selectRecommendableCapabilities([
      match("marketing-expert", "vellum-ai/marketing-expert", "Full-stack marketing."),
      match("admin-copilot", "vellum-ai/admin-copilot", "Chief-of-staff."),
      match("caveman", "JuliusBrussee/caveman", "Compression mode."),
      match("dynamic-notch", "AnitaKirkovska/dynamic-notch", "Notch UI."),
      match("ai-hero-engineer-kit", "marinatrajk/ai-hero-engineer-kit", "Eng skills."),
    ]);

    expect([...validNames].sort()).toEqual(["admin-copilot", "marketing-expert"]);
    expect(capabilities.map((c) => c.name).sort()).toEqual([
      "admin-copilot",
      "marketing-expert",
    ]);
  });

  test("drops vellum-hosted infra/meta plugins (simple-memory, level-up)", () => {
    const { validNames } = selectRecommendableCapabilities([
      match("simple-memory", "vellum-ai/simple-memory", "Reference memory."),
      match("level-up", "vellum-ai/level-up", "Self-edit diff card."),
      match("git-workflow", "vellum-ai/git-workflow", "Git tools."),
    ]);

    expect([...validNames]).toEqual(["git-workflow"]);
  });

  test("drops entries missing a description", () => {
    const { validNames } = selectRecommendableCapabilities([
      match("marketing-expert", "vellum-ai/marketing-expert"),
    ]);

    expect(validNames.size).toBe(0);
  });

  test("compacts descriptions to one short clause", () => {
    const long =
      "Acts as a full-stack marketing expert for any business. " +
      "Includes positioning, demand planning, launches, content, brand voice, SEO, and competitive teardown playbooks.";
    const { capabilities } = selectRecommendableCapabilities([
      match("marketing-expert", "vellum-ai/marketing-expert", long),
    ]);

    expect(capabilities[0]?.description).toBe(
      "Acts as a full-stack marketing expert for any business.",
    );
  });
});

describe("resolveOnboardingPluginInstalls", () => {
  test("includes admin-copilot from the first-party catalog for every role", () => {
    const { validNames } = selectRecommendableCapabilities([
      match("admin-copilot", "vellum-ai/admin-copilot", "Chief-of-staff."),
      match("marketing-expert", "vellum-ai/marketing-expert", "Full-stack marketing."),
    ]);

    expect(
      resolveOnboardingPluginInstalls({
        role: "Teacher",
        validNames,
        modelPlugins: [],
      }),
    ).toEqual(["admin-copilot"]);
  });

  test("dedupes deterministic and model picks while rejecting non-catalog names", () => {
    const { validNames } = selectRecommendableCapabilities([
      match("admin-copilot", "vellum-ai/admin-copilot", "Chief-of-staff."),
      match("marketing-expert", "vellum-ai/marketing-expert", "Full-stack marketing."),
      match("caveman", "JuliusBrussee/caveman", "Compression mode."),
    ]);

    expect(
      resolveOnboardingPluginInstalls({
        role: "Founder",
        validNames,
        modelPlugins: ["marketing-expert", "caveman", "made-up-plugin"],
      }),
    ).toEqual(["admin-copilot", "marketing-expert"]);
  });
});

describe("shouldSettleResearchPoll", () => {
  test("does not settle an incomplete response even after repeated identical polls", () => {
    expect(
      shouldSettleResearchPoll({ complete: false, stableReads: 20 }),
    ).toBe(false);
  });

  test("settles a complete response after the stable-read threshold", () => {
    expect(
      shouldSettleResearchPoll({ complete: true, stableReads: 2 }),
    ).toBe(true);
  });

  test("waits for the complete response to stabilize", () => {
    expect(
      shouldSettleResearchPoll({ complete: true, stableReads: 1 }),
    ).toBe(false);
  });
});

describe("resolveResearchCompletionStatus", () => {
  test("marks complete JSON payloads done", () => {
    expect(
      resolveResearchCompletionStatus({ sawCompletePayload: true }),
    ).toBe("done");
  });

  test("marks timed-out partial payloads as error", () => {
    expect(
      resolveResearchCompletionStatus({ sawCompletePayload: false }),
    ).toBe("error");
  });
});

describe("shouldArchiveCompletedResearchConversation", () => {
  test("archives when a complete payload was observed", () => {
    expect(
      shouldArchiveCompletedResearchConversation({
        sawCompletePayload: true,
      }),
    ).toBe(true);
  });

  test("does not archive partial or timed-out research turns", () => {
    expect(
      shouldArchiveCompletedResearchConversation({
        sawCompletePayload: false,
      }),
    ).toBe(false);
  });
});
