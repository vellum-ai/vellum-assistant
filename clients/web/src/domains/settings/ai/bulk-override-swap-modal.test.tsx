/**
 * Tests for `BulkOverrideSwapModal` eligibility, selection, and the shape
 * of the bulk `PATCH /v1/config` it issues.
 *
 * An action "currently uses" a profile when its explicit override pins one
 * OR when its default resolves to one. Provider/model ("Custom") pins
 * reference no profile, so those actions never appear even when the entry
 * also names the source profile; sites with no resolvable default and no
 * pin carry no profile either.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let configPatchBodies: unknown[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configPatch: async (options?: { body?: unknown }) => {
    configPatchBodies.push(options?.body);
    return { data: {} };
  },
}));

const { BulkOverrideSwapModal } = await import(
  "@/domains/settings/ai/bulk-override-swap-modal"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOMAINS = [
  { id: "agentLoop", displayName: "Agent Loop" },
  { id: "background", displayName: "Background" },
];

// Current profile per action, combining overrides and defaults:
// - workflowLeaf:            override -> balanced
// - subagentSpawn:           no override, default balanced -> balanced
// - conversationTitle:       tuning-only override, default balanced -> balanced
// - memoryRouter:            profileless site; catalog reports only the
//                            shipped Balanced tier -> balanced
// - heartbeatAgent:          live pin -> speed (catalog reports it winning
//                            over the quality tier it would otherwise use)
// - callAgent:               pin naming a profile the resolver skipped, so
//                            the catalog still reports balanced
// - conversationCompaction:  model pin -> Custom, no profile
// - voiceFrontDoor:          neither field (old-daemon shape) -> no profile
const CALL_SITES = [
  {
    id: "workflowLeaf",
    displayName: "Workflow Leaf",
    description: "Runs an ephemeral leaf agent.",
    domain: "agentLoop",
    defaultProfile: "balanced",
  },
  {
    id: "subagentSpawn",
    displayName: "Subagent Spawn",
    description: "Spawns a subagent.",
    domain: "agentLoop",
    defaultProfile: "balanced",
  },
  {
    id: "conversationTitle",
    displayName: "Conversation Title",
    description: "Creates a short title.",
    domain: "background",
    defaultProfile: "balanced",
  },
  {
    id: "memoryRouter",
    displayName: "Memory Router",
    description: "Routes memory pages for the next turn.",
    domain: "background",
    shippedDefaultProfile: "balanced",
  },
  {
    id: "heartbeatAgent",
    displayName: "Heartbeat Agent",
    description: "Runs background tasks on a schedule.",
    domain: "background",
    defaultProfile: "speed",
    shippedDefaultProfile: "quality",
  },
  {
    id: "callAgent",
    displayName: "Call Agent",
    description: "Handles voice call conversations.",
    domain: "background",
    defaultProfile: "balanced",
  },
  {
    id: "conversationCompaction",
    displayName: "Conversation Compaction",
    description: "Summarizes long context.",
    domain: "background",
    defaultProfile: "balanced",
  },
  {
    id: "voiceFrontDoor",
    displayName: "Voice Front Door",
    description: "Fast front-door leg for live voice.",
    domain: "agentLoop",
  },
];

const PERSISTED_OVERRIDES = {
  // Names a disabled profile, so the resolver skips the rung; the catalog
  // reports balanced, which is what this action actually runs on.
  callAgent: { profile: "legacy" },
  workflowLeaf: { profile: "balanced" },
  conversationTitle: { effort: "low" as const },
  heartbeatAgent: { profile: "speed" },
  conversationCompaction: { profile: "balanced", model: "glm-5.2" },
};

const ORDERED_PROFILES = [
  { name: "balanced", label: "Balanced", status: "active" as const },
  { name: "speed", label: "Speed", status: "active" as const },
  { name: "quality", label: "Quality", status: "active" as const },
  { name: "legacy", label: "Legacy", status: "disabled" as const },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let applied = false;
let closed = false;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderModal() {
  return render(
    <Wrapper>
      <BulkOverrideSwapModal
        assistantId="asst-1"
        callSites={CALL_SITES}
        domains={DOMAINS}
        persistedOverrides={PERSISTED_OVERRIDES}
        orderedProfiles={ORDERED_PROFILES}
        onClose={() => {
          closed = true;
        }}
        onApplied={() => {
          applied = true;
        }}
      />
    </Wrapper>,
  );
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function comboboxes(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
  );
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

function rowFor(label: string): HTMLElement {
  const checkbox = Array.from(
    document.querySelectorAll<HTMLElement>('[role="checkbox"]'),
  ).find((cb) => cb.parentElement?.parentElement?.textContent?.includes(label));
  if (!checkbox) {
    throw new Error(`expected a checkbox row for "${label}"`);
  }
  return checkbox;
}

function rowContainerText(label: string): string {
  return rowFor(label).parentElement?.parentElement?.textContent ?? "";
}

beforeEach(() => {
  configPatchBodies = [];
  applied = false;
  closed = false;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BulkOverrideSwapModal - eligibility", () => {
  test("lists every action currently on the source profile, via override or default", () => {
    renderModal();

    // Balanced: override (workflowLeaf) + defaults (subagentSpawn,
    // tuning-only conversationTitle, shipped-tier-only memoryRouter). The
    // Custom pin and the field-less site stay out; heartbeatAgent is on
    // Speed.
    expect(renderedText()).toContain("5 actions currently use Balanced");
    expect(renderedText()).toContain("Workflow Leaf");
    expect(renderedText()).toContain("Subagent Spawn");
    expect(renderedText()).toContain("Conversation Title");
    expect(renderedText()).toContain("Memory Router");
    // Its pin is dead, so it is filed under what it actually runs on.
    expect(renderedText()).toContain("Call Agent");
    expect(rowContainerText("Call Agent")).toContain("Default");
    expect(renderedText()).not.toContain("Conversation Compaction");
    expect(renderedText()).not.toContain("Voice Front Door");
    expect(renderedText()).not.toContain("Heartbeat Agent");
    expect(renderedText()).toContain("5 actions will change");
  });

  test("rows are marked with how they use the profile", () => {
    renderModal();

    expect(rowContainerText("Workflow Leaf")).toContain("Override");
    expect(rowContainerText("Subagent Spawn")).toContain("Default");
    expect(rowContainerText("Conversation Title")).toContain("Default");
    expect(rowContainerText("Memory Router")).toContain("Default");
  });

  test("source options cover profiles used via defaults, not just overrides", () => {
    renderModal();

    const [sourceTrigger] = comboboxes();
    fireEvent.click(sourceTrigger!);
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    // Balanced (override + defaults), Speed (override), Quality
    // (heartbeatAgent's default is shadowed by its Speed override, so
    // Quality only appears if some action actually runs on it: none does).
    expect(optionLabels).toEqual(["Balanced", "Speed"]);
  });

  test("target options exclude the source and disabled profiles", () => {
    renderModal();

    const targetTrigger = comboboxes()[1];
    fireEvent.click(targetTrigger!);
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(optionLabels).toEqual(["Speed", "Quality"]);
  });

  test("switching the source recomputes the list and resets the selection", () => {
    renderModal();

    fireEvent.click(rowFor("Workflow Leaf"));
    expect(renderedText()).toContain("4 actions will change");

    const [sourceTrigger] = comboboxes();
    pickOption(sourceTrigger!, "Speed");
    expect(renderedText()).toContain("1 action currently uses Speed");
    expect(renderedText()).toContain("Heartbeat Agent");

    // Back to Balanced: the earlier deselection is gone.
    pickOption(comboboxes()[0]!, "Balanced");
    expect(renderedText()).toContain("5 actions will change");
  });
});

describe("BulkOverrideSwapModal - apply", () => {
  test("apply stays disabled until a target profile is chosen", () => {
    renderModal();

    expect(findButton("Apply to 5 actions").disabled).toBe(true);
    pickOption(comboboxes()[1]!, "Quality");
    expect(findButton("Apply to 5 actions").disabled).toBe(false);
  });

  test("apply patches exactly the selected actions and nothing else", async () => {
    renderModal();

    pickOption(comboboxes()[1]!, "Quality");
    fireEvent.click(rowFor("Subagent Spawn"));
    fireEvent.click(rowFor("Memory Router"));
    expect(renderedText()).toContain("3 actions will change");

    fireEvent.click(findButton("Apply to 3 actions"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    // The patch names only the swapped actions: the default-using row gets
    // a brand-new override entry, the override row is rewritten, the dead
    // pin is replaced with a profile that resolves, and the
    // deselected/ineligible rows are absent. Only `profile` is written, so
    // the merge preserves tuning fields on entries that carry them.
    expect(Object.keys(body.llm)).toEqual(["callSites"]);
    expect(body.llm.callSites).toEqual({
      workflowLeaf: { profile: "quality" },
      conversationTitle: { profile: "quality" },
      callAgent: { profile: "quality" },
    });
    expect(applied).toBe(true);
    expect(closed).toBe(true);
  });

  test("clear all empties the selection and disables apply", () => {
    renderModal();

    pickOption(comboboxes()[1]!, "Quality");
    fireEvent.click(findButton("Clear all"));
    expect(renderedText()).toContain("0 actions will change");
    expect(findButton("Apply to 0 actions").disabled).toBe(true);

    fireEvent.click(findButton("Select all"));
    expect(findButton("Apply to 5 actions").disabled).toBe(false);
  });
});
