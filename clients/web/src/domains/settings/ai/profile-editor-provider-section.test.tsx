/**
 * The provider section's ChatGPT-subscription behavior: the steering hint
 * for stale openai profiles in subscription-only workspaces, and the Codex
 * model list with no free-text escape for the chatgpt identity.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => false,
}));

const { ProfileEditorProviderSection } =
  await import("@/domains/settings/ai/profile-editor-provider-section");

const SUBSCRIPTION_CONNECTION = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: { type: "oauth_subscription", credential: "credential/chatgpt" },
};

function renderSection(overrides: Record<string, unknown>) {
  const connections = (overrides.connections ?? []) as never;
  return render(
    <ProfileEditorProviderSection
      provider={"" as never}
      model=""
      providerConnection=""
      onProviderChange={() => {}}
      onModelChange={() => {}}
      onConnectionChange={() => {}}
      connections={connections}
      isReadOnly={false}
      availableConnectionsForProvider={[] as never}
      connectionNotFound={false}
      {...(overrides as object)}
    />,
  );
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** The Model field, which is a filter input rather than a button trigger. */
function modelField(): HTMLInputElement {
  return screen.getByLabelText("Model") as HTMLInputElement;
}

/** Focus opens the list, the same way a pointer press on the field does. */
function openModelList(): void {
  fireEvent.focus(modelField());
}

afterEach(() => {
  cleanup();
});

describe("ProfileEditorProviderSection with a ChatGPT subscription", () => {
  test("a stale openai profile shows the subscription steering hint", () => {
    renderSection({
      provider: "openai",
      connections: [SUBSCRIPTION_CONNECTION],
      availableConnectionsForProvider: [],
    });

    expect(
      screen.queryByText(
        "Your ChatGPT subscription is available as the ChatGPT provider.",
      ),
    ).toBeTruthy();
  });

  test("no hint without a subscription connection", () => {
    renderSection({
      provider: "openai",
      connections: [],
      availableConnectionsForProvider: [],
    });

    expect(
      screen.queryByText(
        "Your ChatGPT subscription is available as the ChatGPT provider.",
      ),
    ).toBeNull();
  });

  test("the chatgpt identity lists Codex models with no custom-id escape", () => {
    renderSection({
      provider: "chatgpt",
      connections: [SUBSCRIPTION_CONNECTION],
      availableConnectionsForProvider: [SUBSCRIPTION_CONNECTION],
    });

    openModelList();

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("GPT-5.6 Terra"))).toBe(true);
    expect(labels.some((l) => l.includes("Nano"))).toBe(false);
    expect(labels.some((l) => l.includes("Enter a custom model ID"))).toBe(
      false,
    );
  });
});

describe("ProfileEditorProviderSection with an openai-compatible connection", () => {
  const connection = {
    name: "lm-studio",
    provider: "openai-compatible",
    auth: { type: "api_key", credential: "credential/openai-compatible/api_key" },
    models: [{ id: "llama-3.1", displayName: "Llama 3.1" }],
  };

  test("keeps a bound model the connection list omits instead of clearing it", () => {
    const onModelChange = mock(() => {});
    renderSection({
      provider: "openai-compatible",
      model: "gateway-alias",
      providerConnection: "lm-studio",
      connections: [connection],
      availableConnectionsForProvider: [connection],
      onModelChange,
    });

    expect(onModelChange).not.toHaveBeenCalled();
    expect(modelField().value).toBe("gateway-alias");
  });

  test("offers the unlisted bound model in the Model dropdown", () => {
    renderSection({
      provider: "openai-compatible",
      model: "gateway-alias",
      providerConnection: "lm-studio",
      connections: [connection],
      availableConnectionsForProvider: [connection],
    });

    openModelList();
    expect(optionLabels()).toContain("gateway-alias");
  });
});
