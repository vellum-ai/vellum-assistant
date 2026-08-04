/**
 * Tests for `OverridesDetailPanel` call-site enumeration and the
 * apply-one-profile-to-all-actions affordance.
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

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configLlmCallsitesGet: mock(async () => ({ data: servedCatalog })),
  configGet: mock(async () => ({ data: servedConfig })),
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: CONFIG };
  },
}));

const { OverridesDetailPanel } =
  await import("@/domains/settings/ai/overrides-detail-panel");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

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
  servedConfig = CONFIG;
  servedCatalog = CATALOG;
  // A hydrated pre-tier-overrides version: the legacy apply-to-all path is
  // rendered AND writable (the Apply button stays disabled while the
  // version is unknown).
  useAssistantIdentityStore.getState().setIdentity("Asst", "0.10.0", "asst-1");
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
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

describe("OverridesDetailPanel - apply to all", () => {
  test("applies the chosen profile to every call site and saves", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Use one profile for all actions");
    });

    // Before a profile is chosen the apply button is inert.
    expect(getButton("Apply to all").disabled).toBe(true);

    // With no override toggled on, the only comboboxes are the apply-all
    // dropdown and the Advisor row's - and apply-all renders first.
    const trigger = document.querySelector<HTMLElement>(
      'button[role="combobox"]',
    );
    if (!trigger) {
      throw new Error("expected the apply-all dropdown trigger");
    }
    pickOption(trigger, "My BYOK");

    fireEvent.click(getButton("Apply to all"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    expect(body.llm.callSites).toEqual({
      workflowLeaf: { profile: "my-byok", provider: null, model: null },
      heartbeatAgent: { profile: "my-byok", provider: null, model: null },
    });
    expect("mainAgent" in body.llm.callSites).toBe(false);
  });

  test("apply-to-all leaves the advisor selection alone", async () => {
    render(
      <Wrapper>
        <OverridesDetailPanel assistantId="asst-1" onClose={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Use one profile for all actions");
    });

    const trigger = document.querySelector<HTMLElement>(
      'button[role="combobox"]',
    );
    if (!trigger) {
      throw new Error("expected the apply-all dropdown trigger");
    }
    pickOption(trigger, "My BYOK");
    fireEvent.click(getButton("Apply to all"));
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    expect("advisorProfile" in body.llm).toBe(false);
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

describe("OverridesDetailPanel - per-tier defaults (0.11.1+)", () => {
  const TIER_CATALOG = {
    domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
    callSites: [
      {
        id: "mainAgent",
        displayName: "Main Agent",
        description: "The primary chat agent.",
        domain: "agentLoop",
        defaultProfile: null,
        shippedDefaultProfile: null,
      },
      {
        id: "workflowLeaf",
        displayName: "Workflow Leaf",
        description: "Runs an ephemeral leaf agent.",
        domain: "agentLoop",
        defaultProfile: "balanced",
        shippedDefaultProfile: "balanced",
      },
      {
        id: "heartbeatAgent",
        displayName: "Heartbeat Agent",
        description: "Runs background tasks on a schedule.",
        domain: "agentLoop",
        defaultProfile: "cost-optimized",
        shippedDefaultProfile: "cost-optimized",
      },
      {
        // Pinned: `defaultProfile` is the winning pin, the shipped tier is
        // cost-optimized. Must count toward Speed, not mint a My BYOK row.
        id: "filingAgent",
        displayName: "Filing Agent",
        description: "Files memories after conversations.",
        domain: "agentLoop",
        defaultProfile: "my-byok",
        shippedDefaultProfile: "cost-optimized",
      },
    ],
  };

  const TIER_CONFIG = {
    llm: {
      ...CONFIG.llm,
      profiles: {
        ...CONFIG.llm.profiles,
        balanced: {
          label: "Balanced",
          provider: "vellum",
          model: "gpt-5.6-luna",
        },
        "cost-optimized": {
          label: "Speed",
          provider: "vellum",
          model: "gpt-5.6-luna",
        },
      },
      callSites: { filingAgent: { profile: "my-byok" } },
    },
  };

  // Fixture catalog with `id`'s resolved winner replaced, mirroring what
  // the daemon reports when a persisted remap (or fallback) won resolution.
  function withWinner(id: string, winner: string) {
    return {
      ...TIER_CATALOG,
      callSites: TIER_CATALOG.callSites.map((cs) =>
        cs.id === id ? { ...cs, defaultProfile: winner } : cs,
      ),
    };
  }

  function renderTierPanel(
    config: unknown = TIER_CONFIG,
    catalog: unknown = TIER_CATALOG,
  ) {
    servedCatalog = catalog;
    servedConfig = config;
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

  function tierTrigger(label: string): HTMLElement {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
    ).find((t) => t.textContent?.includes(label));
    if (!match) {
      throw new Error(`expected a dropdown trigger showing "${label}"`);
    }
    return match;
  }

  beforeEach(() => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Asst", "0.11.1", "asst-1");
  });

  test("renders one Defaults row per shipped tier and hides apply-to-all", async () => {
    renderTierPanel();
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });
    expect(renderedText()).toContain("Balanced (default)");
    expect(renderedText()).toContain("1 action");
    // The pinned Filing Agent counts toward its shipped Speed tier...
    expect(renderedText()).toContain("Speed (default)");
    expect(renderedText()).toContain("2 actions");
    // ...and its winning pin must not mint a tier row of its own.
    expect(renderedText()).not.toContain("My BYOK (default)");
    expect(renderedText()).not.toContain("Use one profile for all actions");
  });

  test("remapping a tier saves only the changed key and shows provenance", async () => {
    renderTierPanel();
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });

    pickOption(tierTrigger("Balanced (default)"), "My BYOK");
    // The unpinned Balanced-tier row reflects the pending remap as a ghost
    // dropdown with tier provenance.
    expect(renderedText()).toContain("via Balanced default");

    fireEvent.click(getButton("Save"));
    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    expect(body.llm.defaultProfileOverrides).toEqual({ balanced: "my-byok" });
    // No call-site row moved, so the map must not be sent.
    expect("callSites" in body.llm).toBe(false);
  });

  test("clearing a persisted remap sends null for that tier", async () => {
    renderTierPanel(
      {
        llm: {
          ...TIER_CONFIG.llm,
          defaultProfileOverrides: { "cost-optimized": "my-byok" },
        },
      },
      withWinner("heartbeatAgent", "my-byok"),
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });
    // The persisted remap is visible on the tier row and as ghost provenance
    // on unpinned Speed-tier sites.
    expect(renderedText()).toContain("via Speed default");
    // The pinned Filing Agent keeps its winner caption without an arrow:
    // its pin outranks the remap.
    expect(renderedText()).toContain("Default: My BYOK");

    pickOption(tierTrigger("My BYOK"), "Speed (default)");
    fireEvent.click(getButton("Save"));
    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    expect(body.llm.defaultProfileOverrides).toEqual({
      "cost-optimized": null,
    });
  });

  // The card containing `rowText`, for scoping queries to one call-site row.
  function rowCard(rowText: string): HTMLElement {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>("div.rounded-lg"),
    ).find((d) => d.textContent?.includes(rowText));
    if (!match) {
      throw new Error(`expected a row card containing "${rowText}"`);
    }
    return match;
  }

  test("a remapped unpinned row shows a ghost dropdown, toggle stays off", async () => {
    renderTierPanel(
      {
        llm: {
          ...TIER_CONFIG.llm,
          defaultProfileOverrides: { balanced: "my-byok" },
        },
      },
      withWinner("workflowLeaf", "my-byok"),
    );
    await waitFor(() => {
      expect(renderedText()).toContain("via Balanced default");
    });
    const card = rowCard("Workflow Leaf");
    const dropdown = card.querySelector<HTMLElement>('button[role="combobox"]');
    expect(dropdown?.textContent).toContain("My BYOK");
    const toggle = card.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
  });

  test("picking from the ghost dropdown creates a real pin", async () => {
    renderTierPanel(
      {
        llm: {
          ...TIER_CONFIG.llm,
          defaultProfileOverrides: { balanced: "my-byok" },
        },
      },
      withWinner("workflowLeaf", "my-byok"),
    );
    await waitFor(() => {
      expect(renderedText()).toContain("via Balanced default");
    });
    const dropdown = rowCard("Workflow Leaf").querySelector<HTMLElement>(
      'button[role="combobox"]',
    );
    if (!dropdown) {
      throw new Error("expected the ghost dropdown");
    }
    pickOption(dropdown, "Quality");
    // The pin flips the toggle on and drops the tier provenance.
    const toggle = rowCard("Workflow Leaf").querySelector<HTMLElement>(
      '[role="switch"]',
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(renderedText()).not.toContain("via Balanced default");

    fireEvent.click(getButton("Save"));
    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    expect(body.llm.callSites.workflowLeaf).toEqual({
      profile: "quality",
      provider: null,
      model: null,
    });
    // The other ghost-eligible rows stay out of the patch.
    expect("heartbeatAgent" in body.llm.callSites).toBe(false);
  });

  test("toggling on a ghost row pins the displayed profile, not the persisted winner", async () => {
    renderTierPanel();
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });
    // Remap Balanced without saving, then flip the Workflow Leaf toggle on:
    // the pin must seed from the remap target the ghost dropdown shows, not
    // from the catalog's persisted `defaultProfile` ("balanced").
    pickOption(tierTrigger("Balanced (default)"), "My BYOK");
    const toggle = rowCard("Workflow Leaf").querySelector<HTMLElement>(
      '[role="switch"]',
    );
    if (!toggle) {
      throw new Error("expected the Workflow Leaf toggle");
    }
    fireEvent.click(toggle);
    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as {
      llm: { callSites: Record<string, unknown> };
    };
    expect(body.llm.callSites.workflowLeaf).toEqual({
      profile: "my-byok",
      provider: null,
      model: null,
    });
  });

  test("untouched ghost rows serialize no per-action pins", async () => {
    renderTierPanel(
      {
        llm: {
          ...TIER_CONFIG.llm,
          defaultProfileOverrides: { balanced: "my-byok" },
        },
      },
      withWinner("workflowLeaf", "my-byok"),
    );
    await waitFor(() => {
      expect(renderedText()).toContain("via Balanced default");
    });
    // Save something unrelated (the advisor) so the patch fires.
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
    // The remap must stay a tier-level fact: no ghost row materializes
    // into `llm.callSites`, else later tier changes stop moving them.
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    expect("callSites" in body.llm).toBe(false);
    expect("defaultProfileOverrides" in body.llm).toBe(false);
  });

  test("a remap the resolver skipped renders the shipped default, not the raw remap", async () => {
    // The persisted remap targets a profile resolution skipped (disabled or
    // incomplete), so the catalog's winner stays the shipped tier. The row
    // must render the plain default caption, not a ghost dropdown claiming
    // the remap applied.
    renderTierPanel({
      llm: {
        ...TIER_CONFIG.llm,
        defaultProfileOverrides: { "cost-optimized": "my-byok" },
      },
    });
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });
    expect(renderedText()).not.toContain("via Speed default");
    expect(renderedText()).toContain("Default: Speed");
  });

  test("Reset clears per-action pins but keeps the tier remaps", async () => {
    renderTierPanel({
      llm: {
        ...TIER_CONFIG.llm,
        defaultProfileOverrides: { "cost-optimized": "my-byok" },
      },
    });
    await waitFor(() => {
      expect(renderedText()).toContain("Defaults");
    });

    fireEvent.click(getButton("Reset to Defaults"));
    // Confirm dialog: the destructive confirm carries the same label.
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.textContent?.trim() === "Reset to Defaults")[1];
    if (!confirm) {
      throw new Error("expected the confirm dialog button");
    }
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    // Per-action pins are nulled; the user's tier configuration is not an
    // override to reset and must not be touched.
    expect(body.llm.callSites).toBeTruthy();
    expect("defaultProfileOverrides" in body.llm).toBe(false);
  });

  test("an unknown assistant version falls back to a non-writing apply-to-all", async () => {
    useAssistantIdentityStore.getState().clearIdentity();
    renderTierPanel();
    await waitFor(() => {
      expect(renderedText()).toContain("Use one profile for all actions");
    });
    expect(renderedText()).not.toContain("Balanced (default)");
    // Non-writing until the version hydrates: on a tier-overrides daemon a
    // sweep would persist pins that outrank the tier remaps.
    const trigger = document.querySelector<HTMLElement>(
      'button[role="combobox"]',
    );
    if (!trigger) {
      throw new Error("expected the apply-all dropdown trigger");
    }
    pickOption(trigger, "My BYOK");
    expect(getButton("Apply to all").disabled).toBe(true);
  });

  test("a version fetched for a different assistant keeps the gate off", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Other", "0.11.1", "asst-other");
    renderTierPanel();
    await waitFor(() => {
      expect(renderedText()).toContain("Use one profile for all actions");
    });
    expect(renderedText()).not.toContain("Balanced (default)");
  });
});
