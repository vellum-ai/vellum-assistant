/**
 * The custom-pin editor is a model choice only: the route comes from the
 * site's winning profile, so the model list is scoped by that route's
 * provider kind and no provider is ever written into a draft.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { getDefaultModelForProvider } from "@/assistant/llm-model-catalog";
import { CUSTOM_SENTINEL } from "@/domains/settings/ai/call-site-helpers";
import { CallSiteOverrideRow } from "@/domains/settings/ai/call-site-overrides-row";

const drafts: unknown[] = [];

const PROFILE_OPTIONS = [
  { value: "balanced", label: "Balanced" },
  { value: CUSTOM_SENTINEL, label: "Custom" },
];

function renderRow(
  draft: Record<string, unknown> | null,
  options?: {
    winningProvider?: string;
    connections?: Record<string, unknown>[];
  },
) {
  return render(
    <CallSiteOverrideRow
      id="workflowLeaf"
      displayName="Workflow Leaf"
      defaultProfileLabel="Balanced"
      draft={draft as never}
      profileOptions={PROFILE_OPTIONS as never}
      winningProvider={options?.winningProvider}
      connections={options?.connections as never}
      onDraftChange={(_id, next) => {
        drafts.push(next);
      }}
      onToggle={() => {}}
    />,
  );
}

function triggers(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
  );
}

function triggerLabels(): string[] {
  return triggers().map((t) => t.textContent?.trim() ?? "");
}

/** The row renders two pickers in order: profile, model. */
function modelTrigger(): HTMLElement {
  const all = triggers();
  const el = all[1];
  if (!el) {
    throw new Error(`expected a model trigger, saw ${all.length} comboboxes`);
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
});

describe("CallSiteOverrideRow custom pin", () => {
  test("a custom draft renders the profile and model pickers only", () => {
    renderRow({ model: "claude-fable-5" }, { winningProvider: "anthropic" });

    expect(triggers().length).toBe(2);
  });

  test("picking Custom sends a model-only draft", () => {
    renderRow({ profile: "balanced" }, { winningProvider: "anthropic" });

    const profileTrigger = triggers()[0]!;
    fireEvent.click(profileTrigger);
    const custom = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "Custom");
    expect(custom).toBeTruthy();
    fireEvent.click(custom!);

    expect(drafts.at(-1)).toEqual({
      profile: null,
      model: getDefaultModelForProvider("anthropic"),
    });
  });

  test("picking a model keeps the draft model-only", () => {
    renderRow({ model: "claude-fable-5" }, { winningProvider: "anthropic" });

    fireEvent.click(modelTrigger());
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "Claude Opus 5");
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    expect(drafts.at(-1)).toEqual({ model: "claude-opus-5" });
  });
});

describe("CallSiteOverrideRow model scoping by the winning route", () => {
  test("a BYOK winner scopes the list to its provider's catalog", () => {
    renderRow({ model: "claude-fable-5" }, { winningProvider: "anthropic" });

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("Claude Fable 5"))).toBe(true);
    expect(labels.some((l) => l.includes("GPT-5.6 Luna"))).toBe(false);
  });

  test("a vellum winner offers the managed model union", () => {
    renderRow({ model: "claude-fable-5" }, { winningProvider: "vellum" });

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("Claude Fable 5"))).toBe(true);
    expect(labels.some((l) => l.includes("GPT-5.6 Luna"))).toBe(true);
  });

  test("an indeterminate winner falls back to the full catalog union", () => {
    // The daemon validates servability on save, so offering everything is
    // safe; hiding models would strand a user whose winner the client
    // cannot resolve.
    renderRow({ model: "claude-fable-5" });

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("Claude Fable 5"))).toBe(true);
    expect(labels.some((l) => l.includes("GPT-5.6 Luna"))).toBe(true);
    expect(labels.some((l) => l.includes("Llama 3.2"))).toBe(true);
  });

  test("a stored pin outside the offered set stays visible as unavailable", () => {
    // The trigger shows the stored pin instead of rendering blank while the
    // out-of-route value is still saved.
    renderRow({ model: "gpt-5.4-nano" }, { winningProvider: "anthropic" });

    expect(
      triggerLabels().some((l) => l.includes("GPT-5.4 Nano (unavailable)")),
    ).toBe(true);

    fireEvent.click(modelTrigger());
    expect(
      optionLabels().some((l) => l.includes("GPT-5.4 Nano (unavailable)")),
    ).toBe(true);
  });
});

const SUBSCRIPTION_CONNECTION = {
  name: "chatgpt-subscription",
  provider: "openai",
  auth: { type: "oauth_subscription", credential: "credential/chatgpt" },
};

const API_KEY_CONNECTION = {
  name: "openai-personal",
  provider: "openai",
  auth: { type: "api_key", credential: "credential/openai" },
};

// The row identity daemon migration 366 stamps on the subscription row.
const SUBSCRIPTION_CONNECTION_366 = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: { type: "oauth_subscription", credential: "credential/chatgpt" },
};

describe("CallSiteOverrideRow model picker under a ChatGPT subscription", () => {
  test("only Codex-servable models are offered when every openai connection is a subscription", () => {
    renderRow(
      { model: "gpt-5.6-luna" },
      { winningProvider: "openai", connections: [SUBSCRIPTION_CONNECTION] },
    );

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("GPT-5.6 Luna"))).toBe(true);
    // The Codex endpoint rejects gpt-5.4-nano; offering it saves a pin that
    // fails on every request.
    expect(labels.some((l) => l.includes("Nano"))).toBe(false);
  });

  test("a migrated subscription row (provider chatgpt) does not gate an openai winner", () => {
    // Post-366 semantics: dispatch matches connections by exact provider,
    // so the subscription cannot serve an openai route.
    renderRow(
      { model: "gpt-5.6-luna" },
      { winningProvider: "openai", connections: [SUBSCRIPTION_CONNECTION_366] },
    );

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("a chatgpt winner offers the Codex model list", () => {
    renderRow(
      { model: "gpt-5.6-terra" },
      {
        winningProvider: "chatgpt",
        connections: [SUBSCRIPTION_CONNECTION_366],
      },
    );

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("GPT-5.6 Terra"))).toBe(true);
    expect(labels.some((l) => l.includes("Nano"))).toBe(false);
  });

  test("an api-key connection restores the full openai catalog", () => {
    renderRow(
      { model: "gpt-5.6-luna" },
      {
        winningProvider: "openai",
        connections: [SUBSCRIPTION_CONNECTION, API_KEY_CONNECTION],
      },
    );

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("absent connection data leaves the winner's catalog unfiltered", () => {
    renderRow({ model: "gpt-5.6-luna" }, { winningProvider: "openai" });

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });
});
