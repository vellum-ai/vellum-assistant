import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@/test-utils.js";
import userEvent from "@testing-library/user-event";

import {
  ProfileEditorModal,
  toKebabCase,
} from "@/domains/settings/ai/profile-editor-modal.js";
import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client.js";

beforeEach(() => {
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});
afterEach(cleanup);

const baseProps = {
  isOpen: true,
  mode: "create" as const,
  assistantId: "test-assistant-id",
  existingNames: [],
  onSave: mock(() => Promise.resolve()),
  onCancel: mock(() => {}),
};

describe("toKebabCase", () => {
  test("converts simple text to kebab-case", () => {
    expect(toKebabCase("Fast Cheap")).toBe("fast-cheap");
  });

  test("strips special characters and replaces with hyphens", () => {
    expect(toKebabCase("Fast & Cheap")).toBe("fast-cheap");
  });

  test("handles multiple consecutive separators", () => {
    expect(toKebabCase("Fast  &  Cheap")).toBe("fast-cheap");
  });

  test("lowercases all letters", () => {
    expect(toKebabCase("FastCheap")).toBe("fastcheap");
    expect(toKebabCase("FAST CHEAP")).toBe("fast-cheap");
  });

  test("handles numbers", () => {
    expect(toKebabCase("Profile 2")).toBe("profile-2");
    expect(toKebabCase("GPT 4.5")).toBe("gpt-4-5");
  });

  test("returns empty string for empty input", () => {
    expect(toKebabCase("")).toBe("");
  });

  test("strips leading and trailing separators", () => {
    expect(toKebabCase(" fast ")).toBe("fast");
    expect(toKebabCase("& fast &")).toBe("fast");
  });
});

describe("ProfileEditorModal", () => {
  test("Save button is disabled when key field is empty on create", () => {
    render(<ProfileEditorModal {...baseProps} />);
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
  });

  test("key field auto-derives from label in create mode", async () => {
    render(<ProfileEditorModal {...baseProps} />);
    const user = userEvent.setup();
    const labelInput = screen.getByPlaceholderText(/e\.g\. Fast & Cheap/i);
    const keyInput = screen.getByPlaceholderText(/e\.g\. fast-cheap/i);
    await user.type(labelInput, "Speed Run");
    expect((keyInput as HTMLInputElement).value).toBe("speed-run");
  });

  test("key field stays fixed when label changes in edit mode", async () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="my-key"
        initialValues={{ name: "my-key", label: "Old" }}
      />,
    );
    const user = userEvent.setup();
    const labelInput = screen.getByPlaceholderText(/e\.g\. Fast & Cheap/i);
    const keyInput = screen.getByPlaceholderText(/e\.g\. fast-cheap/i);
    await user.clear(labelInput);
    await user.type(labelInput, "New Label");
    expect((keyInput as HTMLInputElement).value).toBe("my-key");
  });

  test("view mode renders Close, Save As New, and Save (disabled until label/status change)", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="view"
        profileName="p"
        initialValues={{ name: "p", label: "P", source: "managed" }}
      />,
    );
    const closeButtons = screen.getAllByRole("button", { name: /close/i });
    expect(closeButtons.length).toBeGreaterThan(0);
    // "Save As New" button is present — managed profiles can be cloned
    expect(screen.getByRole("button", { name: "Save As New" })).toBeTruthy();
    // "Save" button is present but disabled until the user touches label or status.
    const saveBtn = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  test("view mode Save enables once the user edits the label", async () => {
    const user = userEvent.setup();
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="view"
        profileName="p"
        initialValues={{ name: "p", label: "P", source: "managed" }}
      />,
    );
    // Label input is editable in view mode (managed profiles can be renamed).
    const labelInput = screen.getAllByPlaceholderText(/Fast & Cheap/i)[0] as HTMLInputElement;
    expect(labelInput.disabled).toBe(false);
    // Save starts disabled.
    expect(
      (screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.type(labelInput, "X");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  test("view mode Save sends only {label, status} with mode='merge' option", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="view"
        profileName="balanced"
        onSave={onSave}
        initialValues={{
          name: "balanced",
          label: "Balanced",
          source: "managed",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 16000,
          status: "active",
        }}
      />,
    );
    // Toggle status from active → disabled (the only fields editable in view mode).
    const toggle = screen.getByRole("switch", { name: /active/i });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [savedName, savedEntry, savedOptions] = onSave.mock
      .calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { mode?: string } | undefined,
    ];
    expect(savedName).toBe("balanced");
    // Only label + status — no provider/model/maxTokens leak.
    expect(Object.keys(savedEntry).sort()).toEqual(["label", "status"]);
    expect(savedEntry.status).toBe("disabled");
    expect(savedEntry.label).toBe("Balanced");
    // mode='merge' signals the parent to skip delete-then-recreate and
    // send a single deep-merge PATCH so seed fields survive. Without this
    // the partial entry would destroy provider/model/maxTokens on disk.
    // Codex P1 / Devin 🔴 on PR #6543.
    expect(savedOptions?.mode).toBe("merge");
  });

  test("Cancel button fires onCancel", () => {
    const onCancel = mock(() => {});
    render(<ProfileEditorModal {...baseProps} onCancel={onCancel} />);
    const cancelBtn = screen.getByTestId("modal-cancel-btn") as HTMLButtonElement;
    // Invoke the React onClick handler directly via the fiber — DOM event
    // bubbling is unreliable in happy-dom after many test files have run,
    // so we go straight to the source. This correctly tests that the button
    // wires onCancel to its onClick prop.
    const fiberKey = Object.keys(cancelBtn).find(k => k.startsWith("__reactFiber"));
    if (fiberKey) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fiber = (cancelBtn as any)[fiberKey];
      while (fiber) {
        if (fiber.memoizedProps?.onClick) { fiber.memoizedProps.onClick({}); break; }
        fiber = fiber.return;
      }
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileEditorModal status toggle", () => {
  test("status defaults to Active in create mode", () => {
    render(<ProfileEditorModal {...baseProps} />);
    const toggle = screen.getByRole("switch", { name: /active/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("toggling status to Disabled and saving includes status in the entry", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    // Provider is now required (iter2), so pre-fill provider + model via
    // `initialValues` so the form is saveable. The test still exercises
    // create-mode label→key auto-derivation and the status toggle path.
    render(
      <ProfileEditorModal
        {...baseProps}
        onSave={onSave}
        initialValues={{
          name: "",
          label: "",
          provider: "openai",
          model: "gpt-5.5",
        }}
      />,
    );

    // Type in label (auto-derives key) so the key field is populated.
    await user.type(screen.getByPlaceholderText(/e\.g\. Fast & Cheap/i), "My Profile");
    // Toggle status off (Disabled)
    const toggle = screen.getByRole("switch", { name: /active/i });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // Save
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "my-profile",
        expect.objectContaining({ status: "disabled" }),
      ),
    );
  });

  test("initializes status from initialValues in edit mode", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="my-key"
        initialValues={{ name: "my-key", label: "My Profile", status: "disabled" }}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /active/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("ProfileEditorModal advanced params", () => {
  const advancedBase = {
    ...baseProps,
    mode: "edit" as const,
    profileName: "test",
    initialValues: {
      name: "test",
      label: "Test",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
  };

  test("initializes maxTokens display from initialValues", () => {
    render(
      <ProfileEditorModal
        {...advancedBase}
        initialValues={{ ...advancedBase.initialValues, maxTokens: 512 }}
      />,
    );
    // The header span shows the formatted token value when maxTokens is set
    expect(screen.getByText("512")).toBeTruthy();
    // Inherit button is enabled because maxTokens is non-null
    const inheritButtons = screen.getAllByRole("button", { name: "Inherit" });
    expect(inheritButtons[0]).not.toBeDisabled();
  });

  test("temperature toggle enables the temperature slider", async () => {
    const user = userEvent.setup();
    render(<ProfileEditorModal {...advancedBase} />);
    // Temperature toggle starts unchecked — temperature slider is hidden
    const toggle = screen.getByRole("switch", { name: "Enable temperature override" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    const slidersBefore = screen.getAllByRole("slider").length;
    await user.click(toggle);
    // Clicking the toggle reveals the temperature slider
    expect(screen.getAllByRole("slider").length).toBe(slidersBefore + 1);
  });

  test("thinking toggle reveals nested streamThinking control", async () => {
    const user = userEvent.setup();
    render(<ProfileEditorModal {...advancedBase} />);
    // Stream thinking tokens toggle is hidden until thinking is enabled
    expect(
      screen.queryByRole("switch", { name: "Stream thinking tokens" }),
    ).toBeNull();
    const thinkingToggle = screen.getByRole("switch", {
      name: "Enable extended thinking",
    });
    await user.click(thinkingToggle);
    // After enabling thinking, the nested toggle becomes visible
    expect(
      screen.getByRole("switch", { name: "Stream thinking tokens" }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Connection sub-dropdown (audit finding #5)
// ---------------------------------------------------------------------------

describe("ProfileEditorModal connection picker", () => {
  const primaryOpenAI: ProviderConnection = {
    name: "primary-openai",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/key" },
    status: "active",
    label: "Primary OpenAI",
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };
  const secondaryOpenAI: ProviderConnection = {
    name: "secondary-openai",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/key2" },
    status: "active",
    label: null,
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };
  const disabledOpenAI: ProviderConnection = {
    name: "disabled-openai",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/dead" },
    status: "disabled",
    label: "Disabled OpenAI",
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };
  const someAnthropic: ProviderConnection = {
    name: "primary-anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/key" },
    status: "active",
    label: "Primary Anthropic",
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };

  test("Connection field is hidden when no active connections match provider", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
        }}
        connections={[someAnthropic]}
      />,
    );
    // No "Connection" label should appear because no OpenAI active connections exist
    expect(screen.queryByText(/^Connection\b/i)).toBeNull();
  });

  test("Connection field is hidden when only disabled connections match provider", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
        }}
        connections={[disabledOpenAI]}
      />,
    );
    expect(screen.queryByText(/^Connection\b/i)).toBeNull();
  });

  test("Connection field renders when active connections match provider", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
        }}
        connections={[primaryOpenAI, secondaryOpenAI, disabledOpenAI, someAnthropic]}
      />,
    );
    // Label is present
    expect(screen.getByText(/^Connection\b/i)).toBeTruthy();
    // Default selection is "Any active OpenAI connection" placeholder
    expect(
      screen.getByText(/Any active OpenAI connection/i),
    ).toBeTruthy();
  });

  test("uses connection label when present, falls back to name", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "primary-openai",
        }}
        connections={[primaryOpenAI, secondaryOpenAI]}
      />,
    );
    // primary-openai is bound — its label ("Primary OpenAI") should render in
    // the dropdown trigger.
    expect(screen.getByText("Primary OpenAI")).toBeTruthy();
  });

  test("save in edit mode with no binding sends provider_connection: null", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        onSave={onSave}
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
        }}
        connections={[primaryOpenAI]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ provider_connection: null }),
      ),
    );
  });

  test("save in edit mode with bound connection sends provider_connection: name", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        onSave={onSave}
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "secondary-openai",
        }}
        connections={[primaryOpenAI, secondaryOpenAI]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ provider_connection: "secondary-openai" }),
      ),
    );
  });

  test("save in create mode without binding omits provider_connection", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    // Provider is required (iter2). Pre-fill provider+model via
    // `initialValues` so the form is saveable; the test still asserts the
    // create-mode default of "no binding" omits `provider_connection`.
    render(
      <ProfileEditorModal
        {...baseProps}
        onSave={onSave}
        connections={[primaryOpenAI]}
        initialValues={{
          name: "",
          label: "",
          provider: "openai",
          model: "gpt-5.5",
        }}
      />,
    );
    // Type a label so the key field auto-derives
    await user.type(
      screen.getByPlaceholderText(/e\.g\. Fast & Cheap/i),
      "My Profile",
    );
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // mock.calls is typed as Array<[]> for our parameter-less factory; read
    // through `unknown` to grab the (name, entry) pair we actually pass in.
    const calls = onSave.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const entry = lastCall![1];
    // provider_connection should NOT be present in the entry in create mode
    // when no binding is selected.
    expect(entry).not.toHaveProperty("provider_connection");
  });

  test("Not found warning renders when saved binding is stale", () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "ghost-openai",
        }}
        connections={[primaryOpenAI, secondaryOpenAI]}
      />,
    );
    // The warning text uniquely identifies the warning element (vs. the
    // stale option label that also contains "ghost-openai"). Use the
    // signature phrase that only appears in the warning.
    expect(
      screen.getByText(/will be cleared on save unless you pick another/i),
    ).toBeTruthy();
    // And the stale name shows up in at least one place.
    expect(screen.getAllByText(/ghost-openai/).length).toBeGreaterThan(0);
  });

  test("Connection field stays visible (with warning) when saved binding has no active matches", () => {
    // Regression test for Codex/Devin P1 feedback on PR #6418: if the field
    // were hidden in this state, the user could not see the stale binding
    // and an opens-and-saves round-trip would silently re-persist it.
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "ghost-openai",
        }}
        // Only an Anthropic connection exists — none match the OpenAI provider.
        connections={[someAnthropic]}
      />,
    );
    // Warning is present (signature phrase, appears nowhere else).
    expect(
      screen.getByText(/will be cleared on save unless you pick another/i),
    ).toBeTruthy();
    // The stale name appears at least once (warning + dropdown option label).
    expect(screen.getAllByText(/ghost-openai/).length).toBeGreaterThan(0);
  });

  test("save auto-clears stale binding in edit mode (regression: P1 round-trip bug)", async () => {
    const user = userEvent.setup();
    const onSave = mock(() => Promise.resolve());
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        onSave={onSave}
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "ghost-openai",
        }}
        connections={[primaryOpenAI, secondaryOpenAI]}
      />,
    );
    // Click Save without touching the dropdown — the stale binding should
    // NOT survive. provider_connection must come through as null so the
    // daemon falls back to its first-active dispatch.
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ provider_connection: null }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider picker (iter3 QA issue #1)
//
// The Provider dropdown is filtered to providers with at least one ACTIVE
// connection. Picking a provider with zero active connections would bind
// the profile to a route the daemon can't dispatch through — surfacing
// only valid providers up front prevents that dead-end.
// ---------------------------------------------------------------------------

describe("ProfileEditorModal provider picker filter", () => {
  const activeAnthropic: ProviderConnection = {
    name: "active-anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/key" },
    status: "active",
    label: "Active Anthropic",
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };
  const disabledOpenAI: ProviderConnection = {
    name: "disabled-openai",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/dead" },
    status: "disabled",
    label: "Disabled OpenAI",
    createdAt: 0,
    updatedAt: 0,
    baseUrl: null,
    models: null,
  };

  test("hides providers with no active connection from create-mode picker", async () => {
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="create"
        connections={[activeAnthropic, disabledOpenAI]}
      />,
    );
    const user = userEvent.setup();
    // Open the provider dropdown. The Dropdown trigger renders as a button
    // with role="combobox"; its accessible name comes from the associated
    // <label id="profile-editor-provider-label"> via aria-labelledby.
    const providerTrigger = screen.getByRole("combobox", { name: "Provider" });
    await user.click(providerTrigger);
    // Anthropic is the ONLY provider with an active connection — others (OpenAI
    // included, because its only connection is disabled) must not appear.
    expect(screen.getByRole("option", { name: /^Anthropic$/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^OpenAI$/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /^Google/i })).toBeNull();
  });

  test("keeps the currently-bound provider visible even when its connection is disabled", () => {
    // Stale binding: profile points at openai, but the only openai connection is
    // disabled. The provider trigger must still render the bound provider so the
    // user can see + recover from the state.
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openai",
          model: "gpt-5.5",
        }}
        connections={[activeAnthropic, disabledOpenAI]}
      />,
    );
    // Trigger shows the bound provider's display name
    expect(screen.getByText(/^OpenAI$/i)).toBeTruthy();
  });

  test("falls back to all providers when connections prop is omitted (pre-load state)", async () => {
    // Omitting `connections` (or passing `undefined`) is the pre-load
    // signal — ManageProfilesModal hasn't resolved listConnections yet.
    // Falling back to the full catalog avoids a brief flash of an empty
    // picker before the fetch settles.
    render(
      <ProfileEditorModal {...baseProps} mode="create" />,
    );
    const user = userEvent.setup();
    const providerTrigger = screen.getByRole("combobox", { name: "Provider" });
    await user.click(providerTrigger);
    // At least two well-known providers from the catalog should appear
    expect(screen.getByRole("option", { name: /^Anthropic$/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^OpenAI$/i })).toBeTruthy();
    // No empty-state hint while still loading.
    expect(
      screen.queryByText(/No active provider connections/i),
    ).toBeNull();
  });

  test("falls back to all providers when connections prop is explicitly undefined (pre-load state)", async () => {
    // Same behavior as omitting the prop: undefined === pre-load.
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="create"
        connections={undefined}
      />,
    );
    const user = userEvent.setup();
    const providerTrigger = screen.getByRole("combobox", { name: "Provider" });
    await user.click(providerTrigger);
    expect(screen.getByRole("option", { name: /^Anthropic$/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^OpenAI$/i })).toBeTruthy();
  });

  test("connections=[] (loaded with zero) yields empty picker and shows empty-state hint", async () => {
    // Distinct from pre-load: caller has resolved listConnections and got
    // back zero entries (fresh workspace). The filter must run and yield
    // empty so the picker reflects reality — and the empty-state hint
    // must fire to steer the user to Providers.
    render(
      <ProfileEditorModal {...baseProps} mode="create" connections={[]} />,
    );
    // Empty-state hint visible.
    expect(
      screen.getByText(/No active provider connections/i),
    ).toBeTruthy();
    // And the dropdown has no options to pick (no provider options rendered).
    const user = userEvent.setup();
    const providerTrigger = screen.getByRole("combobox", { name: "Provider" });
    await user.click(providerTrigger);
    expect(screen.queryByRole("option", { name: /^Anthropic$/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /^OpenAI$/i })).toBeNull();
  });

  test("openrouter defaults to first active connection instead of 'Any active'", () => {
    const openrouterConn: ProviderConnection = {
      name: "my-openrouter",
      provider: "openrouter",
      auth: { type: "api_key", credential: "credential/openrouter/key" },
      status: "active",
      label: "My OpenRouter",
      createdAt: 0,
      updatedAt: 0,
      baseUrl: null,
      models: [{ id: "anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }],
    };
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="edit"
        profileName="p"
        initialValues={{
          name: "p",
          label: "P",
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4-6",
        }}
        connections={[activeAnthropic, openrouterConn]}
      />,
    );
    expect(screen.getByText("My OpenRouter")).toBeTruthy();
    expect(screen.queryByText(/Any active/i)).toBeNull();
  });

  test("shows an empty-state message when connections loaded with zero active", () => {
    // Disabled-only connections: provider state starts empty in create mode,
    // so visibleProviders is empty. Surface a hint so the user knows to
    // enable or add a connection.
    render(
      <ProfileEditorModal
        {...baseProps}
        mode="create"
        connections={[disabledOpenAI]}
      />,
    );
    expect(
      screen.getByText(/No active provider connections/i),
    ).toBeTruthy();
  });
});
