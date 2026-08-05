/**
 * Tests for `BulkOverrideSwapModal` eligibility, selection, and the shape
 * of the bulk `PATCH /v1/config` it issues.
 *
 * Eligibility is profile-only: an override carrying a provider/model pin
 * renders as "Custom" in the editor, so the swap must never list or touch
 * it even when it also names the source profile.
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

const CALL_SITES = [
  {
    id: "workflowLeaf",
    displayName: "Workflow Leaf",
    description: "Runs an ephemeral leaf agent.",
    domain: "agentLoop",
  },
  {
    id: "heartbeatAgent",
    displayName: "Heartbeat Agent",
    description: "Runs background tasks on a schedule.",
    domain: "background",
  },
  {
    id: "subagentSpawn",
    displayName: "Subagent Spawn",
    description: "Spawns a subagent.",
    domain: "agentLoop",
  },
  {
    id: "conversationCompaction",
    displayName: "Conversation Compaction",
    description: "Summarizes long context.",
    domain: "background",
  },
];

// workflowLeaf + heartbeatAgent use Balanced; subagentSpawn uses Speed;
// conversationCompaction names Balanced but carries a model pin, so the
// editor shows it as "Custom" and the swap must skip it.
const PERSISTED_OVERRIDES = {
  workflowLeaf: { profile: "balanced" },
  heartbeatAgent: { profile: "balanced" },
  subagentSpawn: { profile: "speed" },
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

function checkboxFor(label: string): HTMLElement {
  const match = Array.from(
    document.querySelectorAll<HTMLElement>('[role="checkbox"]'),
  ).find((cb) => cb.parentElement?.parentElement?.textContent?.includes(label));
  if (!match) {
    throw new Error(`expected a checkbox row for "${label}"`);
  }
  return match;
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
  test("defaults to the first referenced profile and lists only its profile-only overrides", () => {
    renderModal();

    // Two profile-only Balanced overrides; the model-pinned Balanced row and
    // the Speed row are excluded from the default source's list.
    expect(renderedText()).toContain("2 overrides currently use Balanced");
    expect(renderedText()).toContain("Workflow Leaf");
    expect(renderedText()).toContain("Heartbeat Agent");
    expect(renderedText()).not.toContain("Conversation Compaction");
    expect(renderedText()).not.toContain("Subagent Spawn");
    expect(renderedText()).toContain("2 overrides will change");
  });

  test("source options are the referenced profiles only", () => {
    renderModal();

    const [sourceTrigger] = comboboxes();
    fireEvent.click(sourceTrigger!);
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    // Quality and the disabled Legacy are referenced by nothing.
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

    fireEvent.click(checkboxFor("Workflow Leaf"));
    expect(renderedText()).toContain("1 override will change");

    const [sourceTrigger] = comboboxes();
    pickOption(sourceTrigger!, "Speed");
    expect(renderedText()).toContain("1 override currently uses Speed");
    expect(renderedText()).toContain("Subagent Spawn");

    // Back to Balanced: the earlier deselection is gone.
    pickOption(comboboxes()[0]!, "Balanced");
    expect(renderedText()).toContain("2 overrides will change");
  });
});

describe("BulkOverrideSwapModal - apply", () => {
  test("apply stays disabled until a target profile is chosen", () => {
    renderModal();

    expect(findButton("Apply to 2 overrides").disabled).toBe(true);
    pickOption(comboboxes()[1]!, "Quality");
    expect(findButton("Apply to 2 overrides").disabled).toBe(false);
  });

  test("apply patches exactly the selected call sites and nothing else", async () => {
    renderModal();

    pickOption(comboboxes()[1]!, "Quality");
    fireEvent.click(checkboxFor("Heartbeat Agent"));
    expect(renderedText()).toContain("1 override will change");

    fireEvent.click(findButton("Apply to 1 override"));

    await waitFor(() => {
      expect(configPatchBodies.length).toBe(1);
    });
    const body = configPatchBodies[0] as { llm: Record<string, unknown> };
    // The patch names only the swapped sites: no activeProfile, no
    // advisorProfile, and no entry for the deselected or ineligible rows.
    expect(Object.keys(body.llm)).toEqual(["callSites"]);
    expect(body.llm.callSites).toEqual({
      workflowLeaf: { profile: "quality" },
    });
    expect(applied).toBe(true);
    expect(closed).toBe(true);
  });

  test("clear all empties the selection and disables apply", () => {
    renderModal();

    pickOption(comboboxes()[1]!, "Quality");
    fireEvent.click(findButton("Clear all"));
    expect(renderedText()).toContain("0 overrides will change");
    expect(findButton("Apply to 0 overrides").disabled).toBe(true);

    fireEvent.click(findButton("Select all"));
    expect(findButton("Apply to 2 overrides").disabled).toBe(false);
  });
});
