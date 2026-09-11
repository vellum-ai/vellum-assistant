/**
 * Settings → Personality writes the sidecar only. Onboarding and About
 * Assistant keep the identity rewrite; this page must not start that path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

import {
  PERSONALITY_AXIS_IDS,
  PERSONALITY_SLIDER_DEFAULT,
} from "@vellumai/assistant-api";

const fetchPersonalitySliders = mock(async () => {
  return Object.fromEntries(
    Object.values(PERSONALITY_AXIS_IDS).map((id) => [
      id,
      PERSONALITY_SLIDER_DEFAULT,
    ]),
  );
});
const savePersonalitySliders = mock(async () => true);

mock.module("@/assistant/personality-sliders", () => ({
  PERSONALITY_SLIDER_DEFAULT,
  completeSliderValues: (values: Record<string, number>) =>
    Object.fromEntries(
      Object.values(PERSONALITY_AXIS_IDS).map((id) => [
        id,
        values[id] ?? PERSONALITY_SLIDER_DEFAULT,
      ]),
    ),
  fetchPersonalitySliders,
  personalitySlidersQueryKey: (assistantId: string) => [
    "personality-sliders",
    assistantId,
  ],
  savePersonalitySliders,
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-test",
}));

let vellumHostedInference = true;
let hasHydrated = true;

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    vellumHostedInference: () => vellumHostedInference,
    hasHydrated: () => hasHydrated,
  };
  return { useAssistantFeatureFlagStore: store };
});

const { SettingsPersonalityPage } = await import("./personality-page");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/settings/personality"]}>
        <Routes>
          <Route
            path="/assistant/settings/personality"
            element={<SettingsPersonalityPage />}
          />
          <Route
            path="/assistant/settings/general"
            element={<div>General settings</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPersonalityPage", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    vellumHostedInference = true;
    hasHydrated = true;
    fetchPersonalitySliders.mockImplementation(async () => {
      return Object.fromEntries(
        Object.values(PERSONALITY_AXIS_IDS).map((id) => [
          id,
          PERSONALITY_SLIDER_DEFAULT,
        ]),
      );
    });
    savePersonalitySliders.mockImplementation(async () => true);
  });

  afterEach(() => {
    cleanup();
  });

  test("saves sliders and honors a successful write", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(savePersonalitySliders).toHaveBeenCalledTimes(1);
    });
    expect(savePersonalitySliders).toHaveBeenCalledWith(
      "asst-test",
      Object.fromEntries(
        Object.values(PERSONALITY_AXIS_IDS).map((id) => [
          id,
          PERSONALITY_SLIDER_DEFAULT,
        ]),
      ),
    );
  });

  test("still calls save when the sidecar write fails", async () => {
    savePersonalitySliders.mockImplementation(async () => false);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(savePersonalitySliders).toHaveBeenCalledTimes(1);
    });
  });

  test("redirects to General when hosted inference is off", () => {
    vellumHostedInference = false;
    renderPage();
    expect(screen.getByText("General settings")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
