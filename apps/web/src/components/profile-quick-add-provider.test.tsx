/**
 * Tests for the top-level ProfileQuickAddProvider / useProfileQuickAdd().
 *
 * The provider owns the settings ProfileEditorModal create flow so chat (and
 * other domains) can trigger a profile quick-add without importing settings.
 * We mock the settings modal as a lightweight stub that calls `onSave` with a
 * deterministic entry, then assert the controller persists the new profile via
 * the daemon config PATCH, fires `onCreated` with the new name, and toasts.
 *
 * Mounted with `@testing-library/react` (happy-dom — see `apps/web/test-setup.ts`).
 */

import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement, useEffect } from "react";

const NEW_PROFILE_NAME = "fast-cheap";

// --- resolved assistants store (active assistant id) -------------------------
mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = { activeAssistantId: () => "assistant-1" };
  return { useResolvedAssistantsStore: store };
});

// --- feature flag store ------------------------------------------------------
mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    chatgptSubscriptionAuth: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: () => {} },
}));

// --- ProfileEditorModal stub -------------------------------------------------
// Renders a Save button (only when open) that invokes onSave with a fixed entry.
mock.module("@/domains/settings/ai/profile-editor-modal", () => ({
  ProfileEditorModal: ({ isOpen, onSave }: { isOpen: boolean; onSave: (n: string, e: unknown) => Promise<void> }) =>
    isOpen
      ? createElement(
          "button",
          {
            "data-testid": "modal-save-btn",
            // Mirror the real modal: it awaits onSave inside try/catch and stays
            // open (showing saveError) on rejection. Swallow here so a failing
            // save surfaces via assertions, not an unhandled rejection.
            onClick: () =>
              void onSave(NEW_PROFILE_NAME, { label: "Fast & Cheap" }).catch(() => {}),
          },
          "Save",
        )
      : null,
}));

mock.module("@/domains/settings/ai/provider-connections-client", () => ({
  filterFlaggedConnections: (c: unknown) => c,
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  inferenceProviderconnectionsGetOptions: () => ({
    queryKey: [{ _id: "inferenceProviderconnectionsGet" }],
    queryFn: async () => ({ connections: [] }),
  }),
}));

const clientPatch = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);
// The save path re-reads the latest server config so the appended profileOrder
// is authoritative regardless of what the modal was opened with. Default to one
// pre-existing profile; individual tests override per-call as needed.
const clientGet = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({
    data: { llm: { profileOrder: ["smart"], profiles: { smart: { label: "Smart" } } } },
  }),
);
mock.module("@/generated/api/client.gen", () => ({
  client: { get: clientGet, patch: clientPatch },
}));

import {
    ProfileQuickAddProvider,
    useProfileQuickAdd,
} from "@/components/profile-quick-add-provider";

// Test consumer: opens the quick-add on mount and records the onCreated args.
const onCreated = mock((_name: string, _label: string | null) => {});
function Opener({ existingNames }: { existingNames: string[] }) {
  const { openProfileQuickAdd } = useProfileQuickAdd();
  useEffect(() => {
    openProfileQuickAdd({ existingNames, onCreated });
  }, [openProfileQuickAdd, existingNames]);
  return null;
}

function renderProvider(existingNames: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileQuickAddProvider, null, createElement(Opener, { existingNames })),
    ),
  );
  return { ...result, queryClient };
}

beforeEach(() => {
  toastSuccess.mockClear();
  onCreated.mockClear();
  clientPatch.mockClear();
  clientGet.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ProfileQuickAddProvider", () => {
  test("opens the create modal when openProfileQuickAdd is called", async () => {
    renderProvider(["smart"]);
    await waitFor(() => {
      expect(screen.getByTestId("modal-save-btn")).toBeTruthy();
    });
  });

  test("persisting a create writes the config PATCH, fires onCreated, and toasts", async () => {
    renderProvider(["smart"]);
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    // Persists via the daemon config PATCH with the appended profileOrder.
    await waitFor(() => {
      expect(clientPatch).toHaveBeenCalledTimes(1);
    });
    const patchBody = (clientPatch.mock.calls[0]![0] as { body: { llm: Record<string, unknown> } }).body.llm;
    expect((patchBody.profiles as Record<string, unknown>)[NEW_PROFILE_NAME]).toBeTruthy();
    expect(patchBody.profileOrder).toEqual(["smart", NEW_PROFILE_NAME]);

    // Hands the new key and its display-name label back to the caller so the
    // picker can render the entry's Name immediately.
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(NEW_PROFILE_NAME, "Fast & Cheap");
    });

    // Surfaces the success toast (by display name) and closes the modal.
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(`Profile "Fast & Cheap" created`);
    });
    expect(screen.queryByTestId("modal-save-btn")).toBeNull();
  });

  test("the save path reads the LATEST server config — appends to the server order, not the (stale/empty) opener input", async () => {
    // Server already has two profiles in a specific order. The opener was given
    // an EMPTY existingNames (simulating a click before config loaded); the
    // PATCH must still append to the server's order, preserving both existing
    // profiles rather than resetting the order to just the new name.
    clientGet.mockImplementationOnce(async () => ({
      data: {
        llm: {
          profileOrder: ["smart", "creative"],
          profiles: { smart: { label: "Smart" }, creative: { label: "Creative" } },
        },
      },
    }));

    renderProvider([]); // opener passes no existing names
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    await waitFor(() => {
      expect(clientPatch).toHaveBeenCalledTimes(1);
    });
    // Re-read the freshest config before persisting.
    expect(clientGet).toHaveBeenCalledTimes(1);
    const patchBody = (clientPatch.mock.calls[0]![0] as { body: { llm: Record<string, unknown> } }).body.llm;
    expect(patchBody.profileOrder).toEqual(["smart", "creative", NEW_PROFILE_NAME]);
  });

  test("the save path ABORTS when the name already exists on fresh server state — never overwrites an existing profile", async () => {
    // The new name already exists on the server (in the map), e.g. created by
    // another client while the modal was open. A create must NOT deep-merge over
    // it (config PATCHes merge profile entries) — it must abort with no PATCH.
    clientGet.mockImplementationOnce(async () => ({
      data: {
        llm: {
          profileOrder: ["smart"],
          profiles: { smart: { label: "Smart" }, [NEW_PROFILE_NAME]: { label: "Existing" } },
        },
      },
    }));

    renderProvider([]);
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    // The reload ran, but the duplicate is rejected: no PATCH, no success, and
    // the modal stays open so the inline error is visible.
    await waitFor(() => {
      expect(clientGet).toHaveBeenCalledTimes(1);
    });
    expect(clientPatch).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("modal-save-btn")).toBeTruthy();
  });

  test("invalidates the daemon config cache after a successful create so Settings stays in sync", async () => {
    const { queryClient } = renderProvider(["smart"]);
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    await waitFor(() => {
      expect(clientPatch).toHaveBeenCalledTimes(1);
    });
    // The shared daemon-config query is invalidated so a previously-loaded
    // Settings/AI tab refetches and shows the newly created profile.
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: assistantDaemonConfigQueryKey("assistant-1"),
      });
    });
  });

  test("a failed config reload ABORTS the save — no PATCH, no success toast, modal stays open", async () => {
    // The fresh config read fails (throwOnError: true rejects). The save must
    // abort rather than fall back to empty server state and reset profileOrder.
    clientGet.mockImplementationOnce(async () => {
      throw new Error("config read failed");
    });

    renderProvider(["smart"]);
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    // The reload was attempted, but the PATCH never runs and nothing is reported
    // as a success; the modal remains open so the inline error is visible.
    await waitFor(() => {
      expect(clientGet).toHaveBeenCalledTimes(1);
    });
    expect(clientPatch).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("modal-save-btn")).toBeTruthy();
  });
});
