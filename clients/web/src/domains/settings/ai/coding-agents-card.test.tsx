/**
 * Tests for `CodingAgentsCard`, which writes `acp.defaultModel`:
 *
 *   1. Save is disabled until the picked model differs from the stored one.
 *   2. A PATCH carries only the `acp` section, never a neighbouring service.
 *   3. The agent-default row clears the setting with an explicit `null`.
 *   4. A custom model reaches the daemon exactly as typed, since the adapter
 *      accepts ids this list does not enumerate.
 *   5. A stored value outside the list opens on the custom row, pre-filled.
 *   6. The capability gate is scoped to the assistant the card writes to.
 *   7. An assistant that predates the feature gets no card at all.
 *
 * The design-library Select is real, driven through its combobox trigger like
 * `web-search-card.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const ASSISTANT_ID = "asst-test";
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// Controllable daemon config the config-get query resolves to; `initialData`
// makes it available synchronously like a warm cache.
let daemonConfigData: { acp?: { defaultModel?: string } } = {};
interface SdkCall {
  path?: unknown;
  body?: unknown;
}
const configPatchCalls: SdkCall[] = [];
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetSetQueryData: () => {},
  useConfigPatchMutation: () => ({
    mutateAsync: (opts: SdkCall) => {
      configPatchCalls.push(opts);
      return Promise.resolve(daemonConfigData);
    },
  }),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => false,
}));

let supportsModelSwitching = true;
let scopedAssistantIds: (string | null | undefined)[] = [];
mock.module("@/lib/backwards-compat/acp-model-switching", () => ({
  MIN_VERSION: "0.11.10-dev.202609090534.a9ef179",
  useSupportsAcpModelSwitching: () => supportsModelSwitching,
  useAssistantScopedSupportsAcpModelSwitching: (
    assistantId: string | null | undefined,
  ) => {
    scopedAssistantIds.push(assistantId);
    return supportsModelSwitching;
  },
}));

const { CodingAgentsCard } =
  await import("@/domains/settings/ai/coding-agents-card");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CodingAgentsCard />
    </QueryClientProvider>,
  );
}

function modelTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Default coding agent model"]',
  );
  if (!trigger) {
    throw new Error("expected the default model dropdown trigger");
  }
  return trigger;
}

function visibleOptions(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** Click an option in the already-open listbox (the trigger toggles). */
function selectOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected option "${label}", saw: ${visibleOptions().join(", ")}`,
    );
  }
  fireEvent.click(option);
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

function customInput(): HTMLInputElement {
  return screen.getByPlaceholderText("claude-opus-4-1") as HTMLInputElement;
}

describe("CodingAgentsCard", () => {
  beforeEach(() => {
    configPatchCalls.length = 0;
    supportsModelSwitching = true;
    scopedAssistantIds = [];
    daemonConfigData = {};
  });

  afterEach(() => {
    cleanup();
  });

  test("offers the agent default, the aliases, and a custom row", () => {
    renderCard();

    fireEvent.click(modelTrigger());
    expect(visibleOptions()).toEqual([
      "Use the agent's default",
      "Default",
      "Sonnet",
      "Opus",
      "Haiku",
      "Fable",
      "Best available",
      "Opus plan mode",
      "Sonnet (1M context)",
      "Opus (1M context)",
      "Fable (1M context)",
      "Custom model",
    ]);
  });

  test("Save is disabled until the picked model changes", () => {
    renderCard();

    expect(saveButton().disabled).toBe(true);

    fireEvent.click(modelTrigger());
    selectOption("Opus");

    expect(saveButton().disabled).toBe(false);
  });

  test("saving writes only the acp section", async () => {
    renderCard();

    fireEvent.click(modelTrigger());
    selectOption("Opus");
    fireEvent.click(saveButton());

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.path).toEqual({ assistant_id: ASSISTANT_ID });
    expect(configPatchCalls[0]!.body).toEqual({
      acp: { defaultModel: "opus" },
    });
  });

  test("the agent-default row clears the stored model with null", async () => {
    daemonConfigData = { acp: { defaultModel: "opus" } };
    renderCard();

    expect(modelTrigger().textContent).toContain("Opus");
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(modelTrigger());
    selectOption("Use the agent's default");
    fireEvent.click(saveButton());

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toEqual({
      acp: { defaultModel: null },
    });
  });

  test("a custom model reaches the daemon exactly as typed", async () => {
    renderCard();

    fireEvent.click(modelTrigger());
    selectOption("Custom model");

    // Picking the row alone is not a change: an empty custom field still
    // means "no default".
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(customInput(), {
      target: { value: "claude-opus-4-1-20250805" },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toEqual({
      acp: { defaultModel: "claude-opus-4-1-20250805" },
    });
  });

  test("a stored model outside the list opens on the custom row, pre-filled", () => {
    daemonConfigData = { acp: { defaultModel: "gpt-5-codex" } };
    renderCard();

    expect(modelTrigger().textContent).toContain("Custom model");
    expect(customInput().value).toBe("gpt-5-codex");
    expect(saveButton().disabled).toBe(true);
  });

  test("scopes the capability gate to the card's assistant", () => {
    renderCard();

    expect(scopedAssistantIds.length).toBeGreaterThan(0);
    expect(new Set(scopedAssistantIds)).toEqual(new Set([ASSISTANT_ID]));
  });

  test("renders nothing on an assistant that predates model switching", () => {
    supportsModelSwitching = false;
    const { container } = renderCard();

    expect(container.textContent).toBe("");
    expect(document.querySelector('button[role="combobox"]')).toBeNull();
  });
});
