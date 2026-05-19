import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, _fireEvent, render, screen, waitFor } from "@/test-utils.js";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

import { Modal } from "@vellum/design-library/components/modal";
import { client } from "@/generated/api/client.gen.js";
import {
  ProviderEditorContent,
  type ProviderEditorContentProps,
} from "@/domains/settings/ai/provider-editor-modal.js";
import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client.js";

// Local test wrapper. In production the editor is embedded inside
// `ManageProvidersModal`'s own `Modal.Root` (master/detail), so the wrapper
// lives here rather than as an unused export in production code.
interface ProviderEditorModalProps extends ProviderEditorContentProps {
  isOpen: boolean;
}

function ProviderEditorModal({ isOpen, ...rest }: ProviderEditorModalProps) {
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) rest.onCancel();
      }}
    >
      {isOpen ? <ProviderEditorContent {...rest} /> : null}
    </Modal.Root>
  );
}

const originalGet = client.get;
const originalPost = client.post;
const originalPatch = client.patch;
const ok200 = { ok: true, status: 200 } as Response;
const ok201 = { ok: true, status: 201 } as Response;
type SecretEntry = { type: string; name: string };
const mockGet = mock(
  (): Promise<{
    data: { secrets: SecretEntry[] };
    response: Response;
  }> => Promise.resolve({ data: { secrets: [] }, response: ok200 }),
);
const mockPost = mock(() => Promise.resolve({ data: {}, response: ok201 }));
const mockPatch = mock(() => Promise.resolve({ data: {}, response: ok200 }));

beforeEach(() => {
  (client as unknown as Record<string, unknown>).get = mockGet;
  (client as unknown as Record<string, unknown>).post = mockPost;
  (client as unknown as Record<string, unknown>).patch = mockPatch;
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockGet.mockImplementation(() =>
    Promise.resolve({ data: { secrets: [] }, response: ok200 }),
  );
  mockPost.mockImplementation(() =>
    Promise.resolve({ data: {}, response: ok201 }),
  );
  mockPatch.mockImplementation(() =>
    Promise.resolve({ data: {}, response: ok200 }),
  );
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});
afterEach(() => {
  (client as unknown as Record<string, unknown>).get = originalGet;
  (client as unknown as Record<string, unknown>).post = originalPost;
  (client as unknown as Record<string, unknown>).patch = originalPatch;
  cleanup();
});

const existingConnection: ProviderConnection = {
  name: "my-openai",
  provider: "openai",
  auth: { type: "platform" },
  status: "active",
  label: null,
  createdAt: 0,
  updatedAt: 0,
  baseUrl: null,
  models: null,
};

const apiKeyConnection: ProviderConnection = {
  name: "my-anthropic",
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  status: "active",
  label: null,
  createdAt: 0,
  updatedAt: 0,
  baseUrl: null,
  models: null,
};

function makeCreateProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    mode: "create" as const,
    connection: undefined,
    assistantId: "test-assistant",
    existingNames: [],
    onSave: mock(() => {}),
    onCancel: mock(() => {}),
    ...overrides,
  };
}

function makeEditProps(overrides: Record<string, unknown> = {}) {
  return {
    ...makeCreateProps(),
    mode: "edit" as const,
    connection: existingConnection,
    ...overrides,
  };
}

describe("ProviderEditorModal — create mode", () => {
  test("renders display name, key, and provider fields", () => {
    render(<ProviderEditorModal {...makeCreateProps()} />);
    expect(screen.getByPlaceholderText(/My Anthropic Key/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/anthropic-personal/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  test("Create button is disabled when key is empty", () => {
    render(<ProviderEditorModal {...makeCreateProps()} />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  test("typing into Display Name auto-derives Key in create mode", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeCreateProps()} />);
    const labelInput = screen.getByPlaceholderText(/My Anthropic Key/i);
    await user.type(labelInput, "Ab Cd");
    await waitFor(() => {
      const keyInput = screen.getByPlaceholderText(/anthropic-personal/i);
      expect((keyInput as HTMLInputElement).value).toBe("ab-cd");
    });
  });

  test("editing Key manually locks auto-derivation from Display Name", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeCreateProps()} />);
    const keyInput = screen.getByPlaceholderText(/anthropic-personal/i);
    await user.type(keyInput, "mk");
    const labelInput = screen.getByPlaceholderText(/My Anthropic Key/i);
    await user.type(labelInput, "Lb");
    await waitFor(() => {
      expect((keyInput as HTMLInputElement).value).toBe("mk");
    });
  });

  test("shows API Key field only when api_key auth type is selected", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeCreateProps()} />);
    // By default auth type is "platform" — no API Key field
    expect(screen.queryByPlaceholderText(/enter your api key/i)).toBeNull();

    // Open the custom auth-type dropdown, then select "API Key"
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/enter your api key/i)).toBeTruthy(),
    );
  });

  test("shows error when name already exists", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(
      <ProviderEditorModal
        {...makeCreateProps({ existingNames: ["x"] })}
      />,
    );
    const nameInput = screen.getByPlaceholderText(/anthropic-personal/i);
    await user.type(nameInput, "x");
    await waitFor(() =>
      expect(screen.getByText(/already exists/i)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  test("calls createConnection and invokes onSave on success", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    const savedConnection: ProviderConnection = {
      name: "new-conn",
      provider: "anthropic",
      auth: { type: "platform" },
      status: "active",
      label: null,
      createdAt: 1,
      updatedAt: 1,
      baseUrl: null,
      models: null,
    };
    mockPost.mockImplementation(() =>
      Promise.resolve({ data: savedConnection, response: ok201 }),
    );
    const onSave = mock(() => {});
    render(<ProviderEditorModal {...makeCreateProps({ onSave })} />);
    const nameInput = screen.getByPlaceholderText(/anthropic-personal/i);
    await user.type(nameInput, "nc");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(savedConnection));
  });

  test("status defaults to Active and can be toggled to Disabled", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    const savedConnection: ProviderConnection = {
      name: "disabled-conn",
      provider: "anthropic",
      auth: { type: "platform" },
      status: "disabled",
      label: null,
      createdAt: 1,
      updatedAt: 1,
      baseUrl: null,
      models: null,
    };
    mockPost.mockImplementation(() =>
      Promise.resolve({ data: savedConnection, response: ok201 }),
    );
    const onSave = mock(() => {});
    render(<ProviderEditorModal {...makeCreateProps({ onSave })} />);

    // Toggle status to disabled
    const activeToggle = screen.getByRole("switch", { name: /active/i });
    expect(activeToggle.getAttribute("aria-checked")).toBe("true");
    await user.click(activeToggle);
    expect(activeToggle.getAttribute("aria-checked")).toBe("false");

    // Fill in name and save
    await user.type(screen.getByPlaceholderText(/anthropic-personal/i), "dc");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ status: "disabled" }) }),
      );
    });
  });
});

describe("ProviderEditorModal — edit mode", () => {
  test("key and provider fields are disabled in edit mode", () => {
    render(<ProviderEditorModal {...makeEditProps()} />);
    const keyInput = screen.getByDisplayValue("my-openai");
    expect(keyInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("shows the existing connection name in the title description", () => {
    render(<ProviderEditorModal {...makeEditProps()} />);
    // Description text is `Editing "<name>".` for a plain edit (non-managed).
    expect(screen.getByText(/Editing "my-openai"/i)).toBeTruthy();
  });

  test("label field does not auto-update key in edit mode", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeEditProps()} />);
    const labelInput = screen.getByPlaceholderText(/My Anthropic Key/i);
    await user.type(labelInput, "NL");
    // Key is locked to the existing name
    const keyInput = screen.getByDisplayValue("my-openai");
    expect((keyInput as HTMLInputElement).value).toBe("my-openai");
  });
});

describe("ProviderEditorModal — api_key auth", () => {
  test("edit mode: renders masked Input placeholder once credential loads", async () => {
    mockPost.mockImplementation(() =>
      Promise.resolve({
        data: { found: true, masked: "sk-ant-api...Ab1x" },
        response: ok200,
      }),
    );
    render(
      <ProviderEditorModal
        {...makeEditProps({ connection: apiKeyConnection })}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("sk-ant-api...Ab1x"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(/a key is configured/i),
    ).toBeTruthy();
  });

  test("edit mode: API Key field does not call updateConnection until Save is clicked", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    const updatedConnection: ProviderConnection = {
      ...apiKeyConnection,
      updatedAt: 2,
      baseUrl: null,
      models: null,
    };
    // readSecret returns a masked value; other posts (writeSecret, updateConnection response) are covered by patch mock
    mockPost.mockImplementation((opts: { url?: string } = {}) => {
      if (typeof opts.url === "string" && opts.url.includes("secrets/read")) {
        return Promise.resolve({
          data: { found: true, masked: "sk-ant-api...Ab1x" },
          response: ok200,
        });
      }
      return Promise.resolve({ data: {}, response: ok200 });
    });
    mockPatch.mockImplementation(() =>
      Promise.resolve({ data: updatedConnection, response: ok200 }),
    );

    render(
      <ProviderEditorModal
        {...makeEditProps({ connection: apiKeyConnection })}
      />,
    );

    // Wait for loading to complete — the masked placeholder appears once readSecret resolves
    const _apiKeyInput = await screen.findByPlaceholderText("sk-ant-api...Ab1x");

    // Before clicking Save, no updateConnection call
    expect(mockPatch).not.toHaveBeenCalled();

    // Click Save (without entering a new key — uses existing credential)
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
  });

  test("create mode: default credential reference is credential/{provider}/api_key", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Provide an available credential so the dropdown renders
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: {
          secrets: [{ type: "api_key", name: "anthropic" }],
        },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Expand Advanced
    const advancedBtn = screen.getByRole("button", { name: /advanced/i });
    await user.click(advancedBtn);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /credential reference/i }),
      ).toBeTruthy(),
    );

    const credDropdown = screen.getByRole("combobox", {
      name: /credential reference/i,
    });
    expect(credDropdown).toBeTruthy();
    // The selected value should default to credential/anthropic/api_key
    expect(credDropdown.getAttribute("data-value") ?? credDropdown.textContent).toContain("anthropic");
  });

  test("create mode: switching provider regenerates default credential reference", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: {
          secrets: [
            { type: "api_key", name: "anthropic" },
            { type: "api_key", name: "openai" },
          ],
        },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch auth to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Switch provider to openai
    const providerDropdown = screen.getByRole("combobox", { name: /provider/i });
    await user.click(providerDropdown);
    await user.click(screen.getByRole("option", { name: /^openai$/i }));

    // Expand Advanced to check credential reference
    const advancedBtn = screen.getByRole("button", { name: /advanced/i });
    await user.click(advancedBtn);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /credential reference/i }),
      ).toBeTruthy(),
    );

    const credDropdown = screen.getByRole("combobox", {
      name: /credential reference/i,
    });
    // After provider switch to openai, default should be credential/openai/api_key
    expect(credDropdown.getAttribute("data-value") ?? credDropdown.textContent).toContain("openai");
  });

  test("create mode: error when apiKeyValue is empty and no existing credential", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Enter a name so Create is enabled
    const nameInput = screen.getByPlaceholderText(/anthropic-personal/i);
    await user.type(nameInput, "mc");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(
        screen.getByText(/enter an api key or select an existing credential/i),
      ).toBeTruthy(),
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("provider-connections"),
      }),
    );
  });

  test("Advanced section: collapsed by default, expands on click", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Seed at least one anthropic credential so the Advanced section is
    // visible at all — it now hides on the empty state (matches macOS).
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { secrets: [{ type: "api_key", name: "anthropic" }] },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    const advancedBtn = await screen.findByRole("button", { name: /advanced/i });
    expect(advancedBtn.getAttribute("aria-expanded")).toBe("false");

    // Expand
    await user.click(advancedBtn);
    expect(advancedBtn.getAttribute("aria-expanded")).toBe("true");

    // "+ New Credential" button appears only in the expanded section
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /new credential/i })).toBeTruthy(),
    );
  });

  test("Advanced section: dropdown shows only matching-service credentials", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: {
          secrets: [
            { type: "api_key", name: "anthropic" },
            { type: "api_key", name: "openai" },
          ],
        },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Expand Advanced
    const advancedBtn = screen.getByRole("button", { name: /advanced/i });
    await user.click(advancedBtn);

    // Wait for the dropdown to render with the anthropic credential
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /credential reference/i }),
      ).toBeTruthy(),
    );

    // Open the credential reference dropdown
    const credDropdown = screen.getByRole("combobox", {
      name: /credential reference/i,
    });
    await user.click(credDropdown);

    // Should show anthropic credential but NOT openai (provider is anthropic)
    const options = screen.getAllByRole("option");
    const optionTexts = options.map((o) => o.textContent ?? "");
    expect(optionTexts.some((t) => t.includes("anthropic"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("openai"))).toBe(false);
  });

  test("+ New Credential: setting a name and clicking Use updates credential and closes form", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Seed at least one anthropic credential so the Advanced section
    // renders. Once macOS-parity simplification landed, the section is
    // hidden in the empty state — but the + New Credential affordance
    // is still meaningful once there's at least one stored key.
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { secrets: [{ type: "api_key", name: "anthropic" }] },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Expand Advanced (wait for it to appear after credentials load)
    await user.click(
      await screen.findByRole("button", { name: /advanced/i }),
    );

    // Click "+ New Credential"
    await user.click(screen.getByRole("button", { name: /new credential/i }));

    // The inline form should appear
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/e\.g\. team-key/i)).toBeTruthy(),
    );

    // Type a credential name
    const nameField = screen.getByPlaceholderText(/e\.g\. team-key/i);
    await user.type(nameField, "tk");

    // Click Use
    await user.click(screen.getByRole("button", { name: /^use$/i }));

    // Form should close (no more team-key placeholder)
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/e\.g\. team-key/i),
      ).toBeNull(),
    );
  });

  test("0 stored credentials: Advanced section is hidden, only the simple API Key field is shown", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Default mockGet returns { secrets: [] } — the empty state.
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key auth.
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // The simple API Key input IS present.
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/enter your api key/i)).toBeTruthy(),
    );

    // The Advanced disclosure button is NOT rendered when there are zero
    // credentials for the provider — match macOS's simple-input pattern.
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
    // No credential-reference dropdown either.
    expect(
      screen.queryByRole("combobox", { name: /credential reference/i }),
    ).toBeNull();
    // No + New Credential affordance (lives inside Advanced).
    expect(
      screen.queryByRole("button", { name: /new credential/i }),
    ).toBeNull();
  });

  test("0 stored credentials: typing an API key + Create still saves a connection using the default credential ref", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Default mockGet returns empty secrets. POST handler will receive
    // both the writeSecret call (saves the key) and the createConnection
    // call (creates the row). Use a generic handler that succeeds for
    // both. Return shape for createConnection drives onSave.
    const savedConnection: ProviderConnection = {
      name: "fresh-conn",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
      status: "active",
      label: null,
      createdAt: 1,
      updatedAt: 1,
      baseUrl: null,
      models: null,
    };
    mockPost.mockImplementation((opts: { url?: string } = {}) => {
      if (
        typeof opts.url === "string" &&
        opts.url.includes("provider-connections")
      ) {
        return Promise.resolve({ data: savedConnection, response: ok201 });
      }
      return Promise.resolve({ data: {}, response: ok200 });
    });
    const onSave = mock(() => {});
    render(<ProviderEditorModal {...makeCreateProps({ onSave })} />);

    // Switch to api_key.
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // No Advanced section is visible (empty state).
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();

    // Fill in name + API key via the simple input only.
    await user.type(
      screen.getByPlaceholderText(/anthropic-personal/i),
      "fc",
    );
    await user.type(
      await screen.findByPlaceholderText(/enter your api key/i),
      "sk1",
    );

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(savedConnection));

    // The createConnection POST should carry auth.credential pointing at
    // the default `credential/<provider>/api_key` ref — the simple flow
    // creates the credential under the hood (matches macOS).
    const postCalls = mockPost.mock.calls as unknown as Array<
      [{ url?: string; body?: unknown }]
    >;
    const createCall = postCalls.find(
      ([opts]) =>
        typeof opts.url === "string" && opts.url.includes("provider-connections"),
    );
    expect(createCall).toBeTruthy();
    const body = createCall![0].body as {
      auth: { type: string; credential: string };
    };
    expect(body.auth.type).toBe("api_key");
    expect(body.auth.credential).toBe("credential/anthropic/api_key");
  });

  test("edit mode + 0 returned credentials: Advanced section STAYS visible so user sees their existing reference (Devin finding on PR #6535)", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Daemon returns an empty credential list — e.g. credential deleted
    // out-of-band, or the daemon hiccuped. The user is editing an
    // existing api_key connection that points at
    // `credential/anthropic/api_key`. The Advanced section must NOT
    // disappear in this state — the user needs to see what reference
    // their connection holds.
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: { secrets: [] }, response: ok200 }),
    );
    mockPost.mockImplementation((opts: { url?: string } = {}) => {
      if (typeof opts.url === "string" && opts.url.includes("secrets/read")) {
        return Promise.resolve({
          data: { found: true, masked: "sk-ant-api...Ab1x" },
          response: ok200,
        });
      }
      return Promise.resolve({ data: {}, response: ok200 });
    });
    render(
      <ProviderEditorModal
        {...makeEditProps({ connection: apiKeyConnection })}
      />,
    );

    // Advanced section is visible — user can still inspect/manage their
    // current credential reference.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /advanced/i }),
      ).toBeTruthy(),
    );

    // Expand to confirm the dropdown still shows the connection's
    // current reference (synthetic option), not a blank value.
    await user.click(screen.getByRole("button", { name: /advanced/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /credential reference/i }),
      ).toBeTruthy(),
    );
    // The current credential reference should appear in the dropdown
    // even though it isn't in `availableCredentials`.
    expect(
      screen.getByText("credential/anthropic/api_key"),
    ).toBeTruthy();
  });

  test("edit mode: orphan credential reference is prepended as a synthetic dropdown option", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Daemon returns OTHER credentials for the provider — but not the
    // one the connection actually points at. The user must still see
    // their orphan reference plus the other options, so they can
    // identify the drift and pick a valid one.
    // listCredentials shapes `api_key` -> credential/{name}/api_key and
    // `credential` (with name `service:field`) -> credential/{service}/{field}.
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: {
          secrets: [
            { type: "api_key", name: "anthropic" },
            { type: "credential", name: "anthropic:team-key" },
          ],
        },
        response: ok200,
      }),
    );
    mockPost.mockImplementation((opts: { url?: string } = {}) => {
      if (typeof opts.url === "string" && opts.url.includes("secrets/read")) {
        return Promise.resolve({
          data: { found: true, masked: "sk-ant-api...Ab1x" },
          response: ok200,
        });
      }
      return Promise.resolve({ data: {}, response: ok200 });
    });
    const orphanConnection: ProviderConnection = {
      ...apiKeyConnection,
      auth: {
        type: "api_key",
        credential: "credential/anthropic/legacy-deleted-key",
      },
    };
    render(
      <ProviderEditorModal
        {...makeEditProps({ connection: orphanConnection })}
      />,
    );
    // Expand Advanced disclosure.
    await user.click(
      await screen.findByRole("button", { name: /advanced/i }),
    );
    // Open the credential reference dropdown so options become queryable.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /credential reference/i }),
      ).toBeTruthy(),
    );
    await user.click(
      screen.getByRole("combobox", { name: /credential reference/i }),
    );
    const optionTexts = screen
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    // Synthetic option for the orphan reference appears alongside the
    // daemon's other returned credentials.
    expect(
      optionTexts.some((t) => t.includes("legacy-deleted-key")),
    ).toBe(true);
    expect(optionTexts.some((t) => t.includes("api_key"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("team-key"))).toBe(true);
  });

  test("≥1 stored credentials: Advanced section IS rendered (preserves existing flow)", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    mockGet.mockImplementation(() =>
      Promise.resolve({
        data: { secrets: [{ type: "api_key", name: "anthropic" }] },
        response: ok200,
      }),
    );
    render(<ProviderEditorModal {...makeCreateProps()} />);

    // Switch to api_key.
    const authDropdown = screen.getByRole("combobox", { name: /auth type/i });
    await user.click(authDropdown);
    await user.click(screen.getByRole("option", { name: "API Key" }));

    // Advanced disclosure renders once credentials load.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /advanced/i }),
      ).toBeTruthy(),
    );
  });

    test("platform auth type: no API Key field, no Advanced section", () => {
    render(<ProviderEditorModal {...makeEditProps()} />);
    expect(screen.queryByPlaceholderText(/enter your api key/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
  });

  test("ollama provider auto-selects none auth and hides API Key field", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<ProviderEditorModal {...makeCreateProps()} />);
    // Switch provider to Ollama — auth type should auto-select "none"
    const providerDropdown = screen.getByRole("combobox", {
      name: /provider/i,
    });
    await user.click(providerDropdown);
    await user.click(screen.getByRole("option", { name: /ollama/i }));
    expect(screen.queryByPlaceholderText(/enter your api key/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Managed-edit mode
// ---------------------------------------------------------------------------
//
// `mode: "managed-edit"` is used for connections whose daemon response
// carries `isManaged: true` (the canonical anthropic-managed /
// openai-managed / gemini-managed rows). The daemon write-protects them
// on DELETE + PATCH-auth but allows PATCH on `label` and `status`. The
// editor mirrors that: auth-related fields (Auth Type, API Key,
// Credential Reference) are disabled; Display Name + Status stay
// editable. Save is shown so users can commit a relabel/disable.

const managedConnection: ProviderConnection = {
  name: "anthropic-managed",
  provider: "anthropic",
  auth: { type: "platform" },
  status: "active",
  label: null,
  createdAt: 0,
  updatedAt: 0,
  baseUrl: null,
  models: null,
  isManaged: true,
};

function makeManagedEditProps(overrides: Record<string, unknown> = {}) {
  return {
    ...makeCreateProps(),
    mode: "managed-edit" as const,
    connection: managedConnection,
    ...overrides,
  };
}

describe("ProviderEditorModal — managed-edit mode", () => {
  test("renders 'Edit Connection' as the title", () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    expect(screen.getByText("Edit Connection")).toBeTruthy();
    // Should not say "View Connection" anymore — managed connections are
    // editable for label + status.
    expect(screen.queryByText("View Connection")).toBeNull();
  });

  test("shows the Save button (label + status are PATCH-able)", () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("Cancel button stays labelled 'Cancel' (never 'Done')", () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  test("Display Name stays editable; Key input is locked", () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    // Label field stays editable — relabeling a managed connection is
    // a supported PATCH on the daemon side.
    expect(screen.getByPlaceholderText(/My Anthropic Key/i)).not.toBeDisabled();
    // Connection name (the key) is still locked outside of create mode,
    // managed or not.
    expect(screen.getByPlaceholderText(/anthropic-personal/i)).toBeDisabled();
  });

  test("Save as New button is visible in managed-edit mode", () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    expect(screen.getByRole("button", { name: "Save as New" })).toBeTruthy();
  });

  test("Save as New button is NOT shown in create or plain edit mode", () => {
    const { unmount } = render(
      <ProviderEditorModal {...makeCreateProps()} />,
    );
    expect(screen.queryByRole("button", { name: "Save as New" })).toBeNull();
    unmount();

    render(<ProviderEditorModal {...makeEditProps()} />);
    expect(screen.queryByRole("button", { name: "Save as New" })).toBeNull();
  });

  test("clicking Save as New transitions to create mode: title, key, auth all editable", async () => {
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    // Pre-click: managed-edit shows "Edit Connection" title.
    expect(screen.getByText("Edit Connection")).toBeTruthy();
    // Key + Auth Type are locked.
    expect(screen.getByPlaceholderText(/anthropic-personal/i)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Save as New" }));

    // Title flips to "New Provider Connection" (matches genuine create mode).
    await waitFor(() => {
      expect(screen.getByText("New Provider Connection")).toBeTruthy();
    });
    // Key field is now editable and empty (cleared so user picks a unique
    // name).
    const keyInput = screen.getByPlaceholderText(
      /anthropic-personal/i,
    ) as HTMLInputElement;
    expect(keyInput).not.toBeDisabled();
    expect(keyInput.value).toBe("");
    // Save as New itself is gone (we're in create mode now).
    expect(screen.queryByRole("button", { name: "Save as New" })).toBeNull();
    // Primary button label is now "Create" (mirroring create mode), not
    // "Save".
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  test("Save as New defaults auth to api_key and surfaces the API Key field", async () => {
    // The managed fixture has auth.type === "platform". After Save as New
    // the auth should default to api_key (the user wants to use their own
    // credential — that's the whole point of cloning off a managed row).
    // Before the click, no API Key field is visible (platform auth has none).
    render(<ProviderEditorModal {...makeManagedEditProps()} />);
    expect(
      screen.queryByRole("textbox", { name: /api key/i }),
    ).toBeNull();

    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    await user.click(screen.getByRole("button", { name: "Save as New" }));

    // After Save as New: the API Key password input appears (api_key auth
    // is now selected).
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Enter your API key/i),
      ).toBeTruthy();
    });
  });

  test("after Save as New, Save invokes createConnection (POST), not updateConnection (PATCH)", async () => {
    const onSave = mock(() => {});
    render(
      <ProviderEditorModal
        {...makeManagedEditProps({ onSave })}
      />,
    );
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    await user.click(screen.getByRole("button", { name: "Save as New" }));

    // Fill in the new Key name + an API key.
    await user.type(
      screen.getByPlaceholderText(/anthropic-personal/i),
      "mc",
    );
    await user.type(
      screen.getByPlaceholderText(/Enter your API key/i),
      "sk1",
    );

    // Mock the writeSecret + createConnection HTTP responses.
    mockPost.mockImplementation(async () => ({
      data: {
        name: "my-anthropic-clone",
        provider: "anthropic",
        auth: { type: "api_key", credential: "credential/anthropic/api_key" },
        status: "active",
        label: null,
        createdAt: 0,
        updatedAt: 0,
      },
      response: ok201,
    }));

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    // The call sequence should include POSTs (writeSecret + createConnection)
    // and NO PATCH (we're creating, not updating the managed row).
    const postCalls = mockPost.mock.calls.length;
    const patchCalls = mockPatch.mock.calls.length;
    expect(postCalls).toBeGreaterThan(0);
    expect(patchCalls).toBe(0);
  });
});
