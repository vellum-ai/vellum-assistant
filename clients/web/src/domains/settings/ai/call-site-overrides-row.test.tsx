/**
 * A pinned provider this assistant cannot select must still be shown as the
 * pin, not swapped for a selectable one.
 *
 * Displaying a fallback while storing something else would be wrong on its
 * own, and `Select` gives it teeth: it reports changes rather than clicks, so
 * re-picking the shown provider is a no-op and the mismatch survives into a
 * save of the wrong provider.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

let selfHosted = false;

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => selfHosted,
}));

const { CallSiteOverrideRow } =
  await import("@/domains/settings/ai/call-site-overrides-row");

const drafts: unknown[] = [];

function renderRow(
  draft: Record<string, unknown> | null,
  connections?: Record<string, unknown>[],
) {
  return render(
    <CallSiteOverrideRow
      id="workflowLeaf"
      displayName="Workflow Leaf"
      defaultProfileLabel="Balanced"
      draft={draft as never}
      profileOptions={[{ value: "balanced", label: "Balanced" }] as never}
      connections={connections as never}
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

  test("a provider this assistant cannot reach is offered disabled with the reason", () => {
    renderRow({ provider: "ollama", model: "llama3" });

    fireEvent.click(providerTrigger());

    const ollama = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).filter((o) => o.textContent?.includes("Ollama"));
    // One row, stating the restriction rather than hiding the provider or
    // duplicating it as an unavailable pin.
    expect(ollama).toHaveLength(1);
    expect(ollama[0]?.textContent).toContain("Self-hosted only");
    expect(ollama[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(optionLabels().some((l) => l.includes("(unavailable)"))).toBe(false);
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

/** The row renders three pickers in order: profile, provider, model. */
function modelTrigger(): HTMLElement {
  const triggers = document.querySelectorAll<HTMLElement>(
    'button[role="combobox"]',
  );
  const el = triggers[2];
  if (!el) {
    throw new Error(
      `expected a model trigger, saw ${triggers.length} comboboxes`,
    );
  }
  return el;
}

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

const VELLUM_CONNECTION = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
};

describe("CallSiteOverrideRow model picker under a ChatGPT subscription", () => {
  test("only Codex-servable models are offered when every openai connection is a subscription", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      SUBSCRIPTION_CONNECTION,
    ]);

    fireEvent.click(modelTrigger());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("GPT-5.6 Luna"))).toBe(true);
    // The Codex endpoint rejects gpt-5.4-nano; offering it saves a pin that
    // fails on every request.
    expect(labels.some((l) => l.includes("Nano"))).toBe(false);
  });

  test("a migrated subscription row (provider chatgpt) does not gate the openai picker", () => {
    // Post-366 semantics: dispatch matches connections by exact provider, so
    // the subscription cannot serve an openai override. The subscription is
    // offered as its own ChatGPT provider entry instead.
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      SUBSCRIPTION_CONNECTION_366,
    ]);

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("the subscription row adds ChatGPT to the provider picker", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      SUBSCRIPTION_CONNECTION_366,
    ]);

    fireEvent.click(providerTrigger());

    expect(optionLabels().some((l) => l.includes("ChatGPT Subscription"))).toBe(
      true,
    );
  });

  test("without the subscription row ChatGPT is not offered", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      API_KEY_CONNECTION,
    ]);

    fireEvent.click(providerTrigger());

    expect(optionLabels().some((l) => l.includes("ChatGPT Subscription"))).toBe(
      false,
    );
  });

  test("a chatgpt draft renders as itself with the Codex model list", () => {
    renderRow({ provider: "chatgpt", model: "gpt-5.6-terra" }, [
      SUBSCRIPTION_CONNECTION_366,
    ]);

    expect(
      triggerLabels().some((l) => l.includes("ChatGPT Subscription")),
    ).toBe(true);

    fireEvent.click(modelTrigger());
    const labels = optionLabels();
    expect(labels.some((l) => l.includes("GPT-5.6 Terra"))).toBe(true);
    expect(labels.some((l) => l.includes("Nano"))).toBe(false);
  });

  test("a chatgpt draft without the subscription renders as an unavailable pin", () => {
    renderRow({ provider: "chatgpt", model: "gpt-5.6-terra" }, [
      API_KEY_CONNECTION,
    ]);

    fireEvent.click(providerTrigger());

    expect(
      optionLabels().some((l) =>
        l.includes("ChatGPT Subscription (unavailable)"),
      ),
    ).toBe(true);
  });

  test("a vellum-managed connection lifts the restriction (openai routes through the managed proxy)", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      SUBSCRIPTION_CONNECTION_366,
      VELLUM_CONNECTION,
    ]);

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("an api-key connection restores the full catalog", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" }, [
      SUBSCRIPTION_CONNECTION,
      API_KEY_CONNECTION,
    ]);

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("absent connection data leaves the catalog unfiltered", () => {
    renderRow({ provider: "openai", model: "gpt-5.6-luna" });

    fireEvent.click(modelTrigger());

    expect(optionLabels().some((l) => l.includes("Nano"))).toBe(true);
  });

  test("a stored pin outside the filtered set stays visible as unavailable", () => {
    renderRow({ provider: "openai", model: "gpt-5.4-nano" }, [
      SUBSCRIPTION_CONNECTION,
    ]);

    // The trigger shows the stored pin instead of rendering blank while the
    // incompatible value is still saved.
    expect(
      triggerLabels().some((l) => l.includes("GPT-5.4 Nano (unavailable)")),
    ).toBe(true);

    fireEvent.click(modelTrigger());
    expect(
      optionLabels().some((l) => l.includes("GPT-5.4 Nano (unavailable)")),
    ).toBe(true);
  });
});
