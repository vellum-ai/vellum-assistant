/**
 * A pinned provider this assistant cannot select must still be shown as the
 * pin, not swapped for a selectable one.
 *
 * Displaying a fallback while storing something else is wrong on its own, but
 * it used to be self-repairing by accident: the deprecated `Dropdown` fired
 * `onChange` for every click, so re-picking the shown provider rewrote the
 * draft to match. Radix `Select` suppresses a change to the value it already
 * holds, which turned the cosmetic lie into a save of the wrong provider.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

let selfHosted = false;

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => selfHosted,
}));

const { CallSiteOverrideRow } = await import(
  "@/domains/settings/ai/call-site-overrides-row"
);

const drafts: unknown[] = [];

function renderRow(draft: Record<string, unknown> | null) {
  return render(
    <CallSiteOverrideRow
      id="workflowLeaf"
      displayName="Workflow Leaf"
      defaultProfileLabel="Balanced"
      draft={draft as never}
      profileOptions={[{ value: "balanced", label: "Balanced" }] as never}
      onDraftChange={(_id, next) => {
        drafts.push(next);
      }}
      onToggle={() => {}}
    />,
  );
}

function triggerLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
  ).map((t) => t.textContent?.trim() ?? "");
}

/**
 * The row renders three pickers in order: profile, provider, model. Index,
 * not text, because the provider trigger's text is the thing under test.
 */
function providerTrigger(): HTMLElement {
  const triggers = document.querySelectorAll<HTMLElement>(
    'button[role="combobox"]',
  );
  const el = triggers[1];
  if (!el) {
    throw new Error(
      `expected a provider trigger, saw ${triggers.length} comboboxes`,
    );
  }
  return el;
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
  drafts.length = 0;
  selfHosted = false;
});

describe("CallSiteOverrideRow provider picker", () => {
  test("a pin this assistant cannot select is shown as itself, marked unavailable", () => {
    // `ollama` is local-only, so a platform-hosted assistant cannot pick it.
    renderRow({ provider: "ollama", model: "llama3" });

    const labels = triggerLabels();
    expect(labels.some((l) => l.includes("Ollama"))).toBe(true);
    // The bug this guards: showing a provider the draft does not hold.
    expect(labels.some((l) => l.includes("Anthropic"))).toBe(false);
  });

  test("the unavailable pin is offered so the user has a way out", () => {
    renderRow({ provider: "ollama", model: "llama3" });

    fireEvent.click(providerTrigger());

    expect(optionLabels().some((l) => l.includes("(unavailable)"))).toBe(true);
  });

  test("picking a real provider over an unavailable pin saves that provider", () => {
    // The repair path. Under the old fallback display this was impossible:
    // the trigger already showed Anthropic, so choosing Anthropic was a
    // no-op and the stale `ollama` was saved.
    renderRow({ provider: "ollama", model: "llama3" });

    fireEvent.click(providerTrigger());
    const anthropic = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "Anthropic");
    expect(anthropic).toBeTruthy();
    fireEvent.click(anthropic!);

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.at(-1)).toMatchObject({ provider: "anthropic" });
  });

  test("a selectable pin is not marked unavailable", () => {
    renderRow({ provider: "anthropic", model: "claude-opus-5" });

    fireEvent.click(providerTrigger());

    expect(optionLabels().some((l) => l.includes("(unavailable)"))).toBe(false);
  });

  test("on a self-hosted assistant ollama is a normal option", () => {
    selfHosted = true;
    renderRow({ provider: "ollama", model: "llama3" });

    fireEvent.click(providerTrigger());

    expect(optionLabels().some((l) => l.includes("(unavailable)"))).toBe(false);
    expect(optionLabels().some((l) => l.includes("Ollama"))).toBe(true);
  });
});
