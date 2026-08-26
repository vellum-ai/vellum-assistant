/**
 * The provider section's ChatGPT-subscription behavior: the steering hint
 * for stale openai profiles in subscription-only workspaces, and the Codex
 * model list with no free-text escape for the chatgpt identity.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => false,
}));

let lookupResult: {
  data?: { id: string; displayName: string };
  error?: unknown;
  response: { ok: boolean; status: number };
} = {
  data: { id: "openrouter/fusion", displayName: "Fusion" },
  response: { ok: true, status: 200 },
};
let lookupCalls: { query?: { id?: string } }[] = [];
let configPatchBodies: unknown[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  inferenceModelsOpenrouterLookupGet: async (options: {
    query?: { id?: string };
  }) => {
    lookupCalls.push(options);
    return lookupResult;
  },
  configPatch: async (options: { body?: unknown }) => {
    configPatchBodies.push(options.body);
    return { data: { llm: options.body }, response: { ok: true, status: 200 } };
  },
}));

const { ProfileEditorProviderSection } =
  await import("@/domains/settings/ai/profile-editor-provider-section");

const SUBSCRIPTION_CONNECTION = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: { type: "oauth_subscription", credential: "credential/chatgpt" },
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    configGetOptions({ path: { assistant_id: "asst-1" } }).queryKey,
    {
      llm: {
        customModels: { openrouter: [] },
        profiles: {},
      },
    },
  );
  return createElement(QueryClientProvider, { client }, children);
}

function renderSection(overrides: Record<string, unknown>) {
  const connections = (overrides.connections ?? []) as never;
  return render(
    <Wrapper>
      <ProfileEditorProviderSection
        assistantId="asst-1"
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
      />
    </Wrapper>,
  );
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
  lookupCalls = [];
  configPatchBodies = [];
  lookupResult = {
    data: { id: "openrouter/fusion", displayName: "Fusion" },
    response: { ok: true, status: 200 },
  };
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

    const modelTrigger = screen.getByLabelText("Model");
    fireEvent.click(modelTrigger);

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
    expect(screen.getByLabelText("Model").textContent?.trim()).toBe(
      "gateway-alias",
    );
  });

  test("offers the unlisted bound model in the Model dropdown", () => {
    renderSection({
      provider: "openai-compatible",
      model: "gateway-alias",
      providerConnection: "lm-studio",
      connections: [connection],
      availableConnectionsForProvider: [connection],
    });

    fireEvent.click(screen.getByLabelText("Model"));
    expect(optionLabels()).toContain("gateway-alias");
  });
});

describe("ProfileEditorProviderSection OpenRouter custom models", () => {
  const openrouterConnection = {
    name: "openrouter",
    provider: "openrouter",
    auth: { type: "api_key", credential: "credential/openrouter/api_key" },
  };

  test("validates a typed OpenRouter id before selecting it", async () => {
    const onModelChange = mock(() => {});
    renderSection({
      provider: "openrouter",
      connections: [openrouterConnection],
      availableConnectionsForProvider: [openrouterConnection],
      onModelChange,
    });

    fireEvent.click(screen.getByLabelText("Model"));
    fireEvent.click(screen.getByRole("option", { name: /Enter a custom model ID/ }));

    expect(onModelChange).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Custom model ID");
    fireEvent.change(input, { target: { value: "openrouter/fusion" } });
    expect(onModelChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lookupCalls.length).toBe(1));
    expect(lookupCalls[0]?.query?.id).toBe("openrouter/fusion");
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith("openrouter/fusion"));
    expect(configPatchBodies[0]).toEqual({
      llm: {
        customModels: {
          openrouter: [{ id: "openrouter/fusion", displayName: "Fusion" }],
        },
      },
    });
  });

  test("shows a not-found error and does not select the id", async () => {
    lookupResult = { error: { message: "not found" }, response: { ok: false, status: 404 } };
    const onModelChange = mock(() => {});
    renderSection({
      provider: "openrouter",
      connections: [openrouterConnection],
      availableConnectionsForProvider: [openrouterConnection],
      onModelChange,
    });

    fireEvent.click(screen.getByLabelText("Model"));
    fireEvent.click(screen.getByRole("option", { name: /Enter a custom model ID/ }));
    fireEvent.change(screen.getByLabelText("Custom model ID"), {
      target: { value: "missing/model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByText("OpenRouter does not list this model ID.")).toBeTruthy(),
    );
    expect(onModelChange).not.toHaveBeenCalled();
    expect(configPatchBodies).toEqual([]);
  });
});
