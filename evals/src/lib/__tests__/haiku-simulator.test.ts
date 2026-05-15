import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { HaikuSimulator } from "../simulator/haiku";

describe("HaikuSimulator", () => {
  test("uses deterministic fallback opening turn when API key is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-sim-"));
    const specPath = join(dir, "SPEC.md");
    await writeFile(specPath, "# spec", "utf8");
    const simulator = new HaikuSimulator({ apiKey: undefined, maxTurns: 4 });

    const decision = await simulator.decide({
      test: {
        id: "timeline-recall",
        specPath,
        metricsDir: join(dir, "metrics"),
        metricPaths: [],
      },
      assistantEvents: [],
      transcript: [],
    });

    expect(decision.action).toBe("send");
    if (decision.action === "send") {
      expect(decision.message.content).toBe(
        "What date did I mention my partner's peanut allergy?",
      );
    }
  });
});
