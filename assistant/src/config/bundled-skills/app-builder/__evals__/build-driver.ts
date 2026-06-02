/**
 * Build drivers: the seam between the harness and an actual app-build flow.
 *
 * A driver takes a golden prompt and returns the source files (and optional
 * plan) the flow produced. Two real drivers are expected to land:
 *
 *  - single-model (baseline) — runs the current app-builder skill once.
 *  - planner-worker (v2)      — runs the tiered flow from this plan.
 *
 * Actually invoking the skill end-to-end (spinning up a conversation, calling
 * the model, executing app-create) is heavier than this scaffolding PR. So we
 * ship {@link StubBuildDriver}: it returns a representative scaffold so the
 * harness produces a scorecard today. Replace with a live driver that wires the
 * real flow — the harness only depends on the {@link AppBuildDriver} interface.
 */

import type {
  AppBuildDriver,
  BuildArtifact,
  GoldenPrompt,
  Variant,
} from "./types.js";

/**
 * Deterministic placeholder driver. Emits the standard formatVersion-2
 * scaffold using a handful of design tokens so compile + plan-adherence checks
 * have something real to run against. It does NOT call a model.
 */
export class StubBuildDriver implements AppBuildDriver {
  constructor(readonly variant: Variant) {}

  async build(prompt: GoldenPrompt): Promise<BuildArtifact> {
    const main = [
      `// stub build for "${prompt.label}" (${this.variant})`,
      "export default function App() {",
      "  return (",
      '    <main style={{ background: "var(--v-bg)", color: "var(--v-text)" }}>',
      `      <h1 style={{ color: "var(--v-accent)" }}>${prompt.label}</h1>`,
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n");

    return { sourceFiles: { "src/main.tsx": main } };
  }
}
