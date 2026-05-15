import { describe, expect, test } from "bun:test";

import type { MetricInput } from "../metrics";
import scoreTimelineRecall from "../../../tests/timeline-recall/metrics/date-mentioned";

describe("timeline-recall metric", () => {
  test("passes when assistant names March 14", () => {
    const result = scoreTimelineRecall({
      profile: {
        id: "vellum-bare",
        manifest: { species: "vellum" },
        workspaceDir: "/tmp/profile",
      },
      test: {
        id: "timeline-recall",
        specPath: "/tmp/SPEC.md",
        metricsDir: "/tmp/metrics",
        metricPaths: [],
      },
      transcript: [
        {
          role: "assistant",
          content: "You mentioned it on March 14.",
          emittedAt: "now",
        },
      ],
      assistantEvents: [],
      simulatorMessages: [],
    } satisfies MetricInput);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  test("fails when assistant does not name the date", () => {
    const result = scoreTimelineRecall({
      profile: {
        id: "vellum-bare",
        manifest: { species: "vellum" },
        workspaceDir: "/tmp/profile",
      },
      test: {
        id: "timeline-recall",
        specPath: "/tmp/SPEC.md",
        metricsDir: "/tmp/metrics",
        metricPaths: [],
      },
      transcript: [
        { role: "assistant", content: "I cannot find it.", emittedAt: "now" },
      ],
      assistantEvents: [],
      simulatorMessages: [],
    } satisfies MetricInput);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });
});
