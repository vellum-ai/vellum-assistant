/**
 * Tests for `OverridesDetailPanel` call-site enumeration, the Advisor row,
 * and per-action pin serialization.
 *
 * The editor auto-enumerates every call-site catalog entry except
 * `mainAgent` (the chat model is picked via the profile picker, not a
 * per-call-site override). We seed the catalog + config query caches
 * (zustand v5 SSR — never `setState`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const CATALOG = {
  domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
  callSites: [
    {
      id: "mainAgent",
      displayName: "Main Agent",
      description: "The primary chat agent.",
      domain: "agentLoop",
      defaultProfile: null,
    },
    {
      id: "workflowLeaf",
      displayName: "Workflow Leaf",
      description: "Runs an ephemeral leaf agent.",
      domain: "agentLoop",
      defaultProfile: null,
    },
    {
      id: "heartbeatAgent",
      displayName: "Heartbeat Agent",
      description: "Runs background tasks on a schedule.",
      domain: "agentLoop",
      defaultProfile: null,
    },
  ],
};

const CONFIG = {
  llm: {
    profiles: {
      "my-byok": {
        label: "My BYOK",
        provider: "anthropic",
        model: "claude-fable-5",
      },
      quality: {
        label: "Quality",
        provider: "anthropic",
        model: "claude-opus-5",
      },
    },
    profileOrder: ["my-byok", "quality"],
    activeProfile: null,
    advisorProfile: "quality",
    callSites: {},
  },
};

let configPatchBodies: unknown[] = [];
// The config the mocked `configGet` serves. Tests that need a different
// persisted shape reassign this, because seeding the query cache alone is
// not enough: `staleTime: 0` refetches and the mock's value wins.
let servedConfig: unknown = CONFIG;
// Same deal for the call-site catalog.
let servedCatalog: unknown = CATALOG;
// Counts catalog fetches so a test can prove a write refetched the winners.
let catalogFetches = 0;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configLlmCallsitesGet: mock(async () => {
    catalogFetches += 1;
    return { data: servedCatalog };
  }),
  configGet: mock(async () => ({ data: servedConfig })),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: CONFIG };
  },
}));

const { OverridesDetailPanel } = await import(
  "@/domains/settings/ai/overrides-detail-panel"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  client.setQueryData([{ _id: "configLlmCallsitesGet" }], CATALOG);
  client.setQueryData([{ _id: "configGet" }], CONFIG);
  return createElement(QueryClientProvider, { client }, children);
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function pickOption(trigger: HTMLElement, optionLabel: string): void {
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(`expected option "${optionLabel}"`);
  }
  fireEvent.click(option);
}

beforeEach(() => {
  configPatchBodies = [];
  catalogFetches = 0;
  servedConfig = CONFIG;
  servedCatalog = CATALOG;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OverridesDetailPanel - call-site enumeration", () => {
  test("renders catalog call sites but excludes mainAgent", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    expect(renderedText()).not.toContain("Main Agent");
  });
});

describe("OverridesDetailPanel - advisor", () => {
  test("renders the advisor row seeded from llm.advisorProfile", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Advisor");
    });
    expect(renderedText()).toContain("second opinion");
    // Seeded selection is visible in the row's dropdown trigger.
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
    );
    expect(triggers.some((t) => t.textContent?.includes("Quality"))).toBe(true);
  });

  test("the advisor row offers no off state", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Advisor");
    });

    const advisorTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
    ).find((t) => t.textContent?.includes("Quality"));
    if (!advisorTrigger) {
      throw new Error("expected the advisor dropdown trigger");
    }
    fireEvent.click(advisorTrigger);
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(optionLabels).toEqual(["My BYOK", "Quality"]);
  });

  test("an advisor-only save omits callSites entirely", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Advisor");
    });

    const advisorTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
    ).find((t) => t.textContent?.includes("Quality"));
    if (!advisorTrigger) {
      throw new Error("expected the advisor dropdown trigger");
    }
    pickOption(advisorTrigger, "My BYOK");
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    expect(body.llm.advisorProfile).toBe("my-byok");
    // No call site was touched. Sending the map anyway would rewrite each
    // entry from the picker's three fields and drop any tuning field
    // (effort, thinking, maxTokens) a persisted entry carries.
    expect("callSites" in body.llm).toBe(false);
  });
});

describe("OverridesDetailPanel - tuning-only entries (LUM-2949)", () => {
  // `isDraftActive` reads only profile/provider/model, so a persisted entry
  // holding nothing but tuning reads as "off". Serializing it to `null`
  // would delete it: see `config-callsite-patch-merge.test.ts`, which pins
  // that a `null` erases the whole entry while an omitted key is preserved.
  const TUNING_ONLY_CONFIG = {
    ...CONFIG,
    llm: {
      ...CONFIG.llm,
      callSites: {
        heartbeatAgent: { effort: "low", thinking: { enabled: false } },
      },
    },
  };

  function renderWith(config: unknown) {
    servedConfig = config;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    client.setQueryData([{ _id: "configLlmCallsitesGet" }], CATALOG);
    client.setQueryData([{ _id: "configGet" }], config);
    return render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(OverridesDetailPanel, {
          assistantId: "asst-1",
          onClose: () => {},
        }),
      ),
    );
  }

  function toggleFor(displayName: string): HTMLElement {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="switch"], input[type="checkbox"]',
      ),
    ).find((el) => (el.getAttribute("aria-label") ?? "").includes(displayName));
    if (!match) {
      throw new Error(`expected a toggle for ${displayName}`);
    }
    return match;
  }

  test("a tuning-only entry the user never touched is omitted, not nulled", async () => {
    renderWith(TUNING_ONLY_CONFIG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });

    // Turn on an override for a different row, then save.
    fireEvent.click(toggleFor("Workflow Leaf"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    // Absent, so the merge leaves the persisted tuning in place. `null`
    // here would delete settings the user never asked to remove.
    expect("heartbeatAgent" in body.llm.callSites).toBe(false);
    expect(body.llm.callSites.workflowLeaf).toBeTruthy();
  });

  // The catalog reports each call site's winning profile, and it is cached
  // with a 60s staleTime. A save changes those winners, so without an
  // explicit invalidation the panel keeps showing the pre-save winner for a
  // full minute — and the bulk swap, which treats the winner as
  // authoritative, would act on it.
  test("saving refetches the call-site winners", async () => {
    renderWith(CONFIG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    const before = catalogFetches;

    fireEvent.click(toggleFor("Workflow Leaf"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    await waitFor(() => {
      expect(catalogFetches).toBeGreaterThan(before);
    });
  });

  test("switching a row off still sends null so the entry is deleted", async () => {
    const ACTIVE_CONFIG = {
      ...CONFIG,
      llm: {
        ...CONFIG.llm,
        callSites: { heartbeatAgent: { profile: "quality", effort: "low" } },
      },
    };
    renderWith(ACTIVE_CONFIG);
    await waitFor(() => {
      expect(renderedText()).toContain("Heartbeat Agent");
    });

    fireEvent.click(toggleFor("Heartbeat Agent"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    expect(body.llm.callSites.heartbeatAgent).toBe(null);
  });
});

describe("OverridesDetailPanel - default caption", () => {
  // `defaultProfile` is the effective winner (pins included); the caption
  // must come from `shippedDefaultProfile` so pinning never changes it.
  const SHIPPED_CATALOG = {
    domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
    callSites: [
      {
        id: "workflowLeaf",
        displayName: "Workflow Leaf",
        description: "Runs an ephemeral leaf agent.",
        domain: "agentLoop",
        defaultProfile: "my-byok",
        shippedDefaultProfile: "quality",
      },
    ],
  };

  test("caption names the shipped tier and holds when the row is pinned", async () => {
    servedCatalog = SHIPPED_CATALOG;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    client.setQueryData([{ _id: "configLlmCallsitesGet" }], SHIPPED_CATALOG);
    client.setQueryData([{ _id: "configGet" }], CONFIG);
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(OverridesDetailPanel, {
          assistantId: "asst-1",
          onClose: () => {},
        }),
      ),
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Default: Quality");
    });

    const toggle = Array.from(
      document.querySelectorAll<HTMLElement>('[role="switch"]'),
    ).find((el) =>
      (el.getAttribute("aria-label") ?? "").includes("Workflow Leaf"),
    );
    if (!toggle) {
      throw new Error("expected the Workflow Leaf toggle");
    }
    fireEvent.click(toggle);
    expect(renderedText()).toContain("Default: Quality");
    expect(renderedText()).not.toContain("Default: My BYOK");
  });
});

describe("OverridesDetailPanel - bulk change", () => {
  function renderWith(config: unknown, catalog: unknown = CATALOG) {
    servedConfig = config;
    servedCatalog = catalog;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    client.setQueryData([{ _id: "configLlmCallsitesGet" }], catalog);
    client.setQueryData([{ _id: "configGet" }], config);
    return render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(OverridesDetailPanel, {
          assistantId: "asst-1",
          onClose: () => {},
        }),
      ),
    );
  }

  const OVERRIDDEN_CONFIG = {
    ...CONFIG,
    llm: {
      ...CONFIG.llm,
      callSites: { workflowLeaf: { profile: "quality" } },
    },
  };

  // A live pin shows up as the call site's winning profile, so the catalog
  // has to report it. The base fixture reports no winner anywhere, which is
  // the shape of a pin the resolver could not use.
  const PINNED_CATALOG = {
    ...CATALOG,
    callSites: CATALOG.callSites.map((cs) =>
      cs.id === "workflowLeaf" ? { ...cs, defaultProfile: "quality" } : cs,
    ),
  };

  test("disabled when no action carries a profile", async () => {
    // The fixture catalog has no default profiles, and a provider/model
    // pin renders as "Custom" and references no profile, so nothing is
    // swappable.
    const CUSTOM_ONLY_CONFIG = {
      ...CONFIG,
      llm: {
        ...CONFIG.llm,
        callSites: {
          workflowLeaf: { provider: "anthropic", model: "claude-fable-5" },
        },
      },
    };
    renderWith(CUSTOM_ONLY_CONFIG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    expect(getButton("Bulk change").disabled).toBe(true);
  });

  test("enabled by default profiles alone, listing them in the modal", async () => {
    // No overrides at all: actions still run on their default profiles,
    // and those count as "currently using" for the bulk swap.
    const DEFAULTED_CATALOG = {
      domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
      callSites: [
        {
          id: "workflowLeaf",
          displayName: "Workflow Leaf",
          description: "Runs an ephemeral leaf agent.",
          domain: "agentLoop",
          defaultProfile: "quality",
        },
        {
          id: "heartbeatAgent",
          displayName: "Heartbeat Agent",
          description: "Runs background tasks on a schedule.",
          domain: "agentLoop",
          defaultProfile: "quality",
        },
      ],
    };
    renderWith(CONFIG, DEFAULTED_CATALOG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });

    const button = getButton("Bulk change");
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      expect(renderedText()).toContain("Change Action Overrides");
    });
    expect(renderedText()).toContain("2 actions currently use Quality");
  });

  test("a pin the resolver skipped leaves nothing to swap", async () => {
    // The catalog reports no winner for the pinned site, so the action is
    // not running on the pinned profile and must not be offered as if it
    // were. The only other entries are Custom pins, so nothing is eligible.
    renderWith(OVERRIDDEN_CONFIG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });
    expect(getButton("Bulk change").disabled).toBe(true);
  });

  test("opens the swap modal seeded with the overridden profile", async () => {
    renderWith(OVERRIDDEN_CONFIG, PINNED_CATALOG);
    await waitFor(() => {
      expect(renderedText()).toContain("Workflow Leaf");
    });

    const button = getButton("Bulk change");
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      expect(renderedText()).toContain("Change Action Overrides");
    });
    expect(renderedText()).toContain("1 action currently uses Quality");
  });

  test("disabled while the editor holds unsaved drafts", async () => {
    renderWith(OVERRIDDEN_CONFIG, PINNED_CATALOG);
    await waitFor(() => {
      expect(renderedText()).toContain("Advisor");
    });

    const advisorTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
    ).find((t) => t.textContent?.includes("Quality"));
    if (!advisorTrigger) {
      throw new Error("expected the advisor dropdown trigger");
    }
    pickOption(advisorTrigger, "My BYOK");

    expect(getButton("Bulk change").disabled).toBe(true);
  });
});
