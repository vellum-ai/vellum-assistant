/**
 * Tests for the catalog filter that decides which plugins onboarding surfaces,
 * plus the runner's subject-key dedupe and the `reset` that releases it.
 *
 * The hard rule: only Vellum-hosted (first-party, reviewed) plugins are ever
 * offered or installed during onboarding — never third-party/external
 * marketplace repos — minus a couple of Vellum-owned infra/meta plugins.
 */

import { createElement, type ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import type { ResearchSubject } from "@/domains/onboarding/research-prompt";
import {
  resolveResearchCompletionStatus,
  resolveOnboardingPluginInstalls,
  selectRecommendableCapabilities,
  shouldSettleResearchPoll,
  useResearchRunner,
} from "@/domains/onboarding/research-runner";

type Match = Parameters<typeof selectRecommendableCapabilities>[0][number];

function match(name: string, repo: string, description?: string): Match {
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
      match(
        "marketing-expert",
        "vellum-ai/marketing-expert",
        "Full-stack marketing.",
      ),
      match("admin-copilot", "vellum-ai/admin-copilot", "Chief-of-staff."),
      match("caveman", "JuliusBrussee/caveman", "Compression mode."),
      match("dynamic-notch", "AnitaKirkovska/dynamic-notch", "Notch UI."),
      match(
        "ai-hero-engineer-kit",
        "marinatrajk/ai-hero-engineer-kit",
        "Eng skills.",
      ),
    ]);

    expect([...validNames].sort()).toEqual([
      "admin-copilot",
      "marketing-expert",
    ]);
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
      match(
        "marketing-expert",
        "vellum-ai/marketing-expert",
        "Full-stack marketing.",
      ),
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
      match(
        "marketing-expert",
        "vellum-ai/marketing-expert",
        "Full-stack marketing.",
      ),
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
    expect(shouldSettleResearchPoll({ complete: false, stableReads: 20 })).toBe(
      false,
    );
  });

  test("settles a complete response after the stable-read threshold", () => {
    expect(shouldSettleResearchPoll({ complete: true, stableReads: 2 })).toBe(
      true,
    );
  });

  test("waits for the complete response to stabilize", () => {
    expect(shouldSettleResearchPoll({ complete: true, stableReads: 1 })).toBe(
      false,
    );
  });
});

describe("resolveResearchCompletionStatus", () => {
  test("marks complete JSON payloads done", () => {
    expect(resolveResearchCompletionStatus({ sawCompletePayload: true })).toBe(
      "done",
    );
  });

  test("marks timed-out partial payloads as error", () => {
    expect(resolveResearchCompletionStatus({ sawCompletePayload: false })).toBe(
      "error",
    );
  });
});

describe("useResearchRunner reset", () => {
  const subject: ResearchSubject = {
    firstName: "Alice",
    lastName: "Example",
    occupation: "Engineer",
    hobbies: [],
    timezone: "UTC",
  };

  function renderRunner() {
    const queryClient = new QueryClient();
    return renderHook(() => useResearchRunner(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
  }

  // Park every run on its hatch await so the turn never reaches the network.
  function pendingHatch() {
    let calls = 0;
    return {
      awaitAssistantId: () => {
        calls += 1;
        return new Promise<string>(() => {});
      },
      get calls() {
        return calls;
      },
    };
  }

  test("dedupes an identical subject until reset releases the key", () => {
    const hatch = pendingHatch();
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: hatch.awaitAssistantId,
        subject,
      });
    });
    expect(result.current.status).toBe("running");
    expect(hatch.calls).toBe(1);

    // The dedupe that makes an unchanged resubmit a no-op.
    act(() => {
      result.current.start({
        awaitAssistantId: hatch.awaitAssistantId,
        subject,
      });
    });
    expect(hatch.calls).toBe(1);

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe("idle");

    // Same subject, but the run it belonged to is gone — so it fires again.
    act(() => {
      result.current.start({
        awaitAssistantId: hatch.awaitAssistantId,
        subject,
      });
    });
    expect(hatch.calls).toBe(2);
    expect(result.current.status).toBe("running");
  });

  test("reset leaves the plugin-install gate resolved", async () => {
    const hatch = pendingHatch();
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: hatch.awaitAssistantId,
        subject,
      });
    });
    act(() => {
      result.current.reset();
    });

    // The abandoned run's click gate would otherwise never resolve.
    await result.current.awaitPluginInstalls();
  });
});

describe("useResearchRunner reinstallPlugins", () => {
  const restored = {
    status: "done" as const,
    claims: [],
    droppedClaims: [],
    suggestions: [],
    installedPlugins: ["admin-copilot"],
    pluginCatalog: {},
  };

  function renderRunner() {
    const queryClient = new QueryClient();
    return renderHook(() => useResearchRunner(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
  }

  /** Did the install gate settle, or is it still holding the handoff? */
  async function raceInstallGate(gate: Promise<void>): Promise<string> {
    return Promise.race([
      gate.then(() => "settled"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("holding"), 20);
      }),
    ]);
  }

  test("re-arms installs that resolved against a dead hatch", async () => {
    const { result } = renderRunner();

    // A resume enqueues the restored installs; the hatch they await then dies,
    // so each swallows the rejection and the gate lets the handoff through with
    // nothing installed.
    act(() => {
      result.current.hydrate(restored, () =>
        Promise.reject(new Error("hatch failed")),
      );
    });
    expect(await raceInstallGate(result.current.awaitPluginInstalls())).toBe(
      "settled",
    );

    // Re-enqueued against the retried hatch, the gate holds again — the handoff
    // waits for the capabilities to genuinely land this time.
    act(() => {
      result.current.reinstallPlugins(
        restored.installedPlugins,
        () => new Promise<string>(() => {}),
      );
    });
    expect(await raceInstallGate(result.current.awaitPluginInstalls())).toBe(
      "holding",
    );
  });

  test("tracks nothing when the run installed nothing", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.reinstallPlugins([], () => new Promise<string>(() => {}));
    });

    // No installs to redo — the click gate must not start blocking.
    expect(await raceInstallGate(result.current.awaitPluginInstalls())).toBe(
      "settled",
    );
  });
});
