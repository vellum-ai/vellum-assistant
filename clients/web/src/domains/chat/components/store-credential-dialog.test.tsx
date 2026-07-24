/**
 * Tests for the "Store securely" flow:
 *
 *   - `suggestCredentialSlot` maps internal detection labels to vault-slot
 *     suggestions (unknown labels → empty strings);
 *   - `rewriteDraftWithStoredCredential` swaps every occurrence of the
 *     secret for its vault-slot placeholder and leaves the rest untouched;
 *   - the dialog pre-fills the shared AddCredentialModal from the detected
 *     secret — the value only ever inside the password input, never as
 *     visible text;
 *   - saving sends the exact detected value to the credentials-set mutation,
 *     rewrites the composer draft (plaintext gone, placeholder present), and
 *     reports the saved slot via `onStored`;
 *   - cancelling leaves the draft untouched and saves nothing;
 *   - switching conversations while the modal is open cancels the store
 *     action — the save can never rewrite the wrong thread's draft or leave
 *     the source plaintext behind under a success toast.
 *
 * Uses the real composer store (reset between tests). All tokens are
 * synthetic values invented for these tests.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  type UseMutationOptions,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  PREFIX_PATTERNS,
  PRIVATE_KEY_LABEL,
  TOKEN_SHAPE_LABEL,
  type DetectedSecret,
} from "@vellumai/service-contracts/secret-detection";

import { useComposerStore } from "@/domains/chat/composer-store";
import type { StoreCredentialDialogProps } from "@/domains/chat/components/store-credential-dialog";

const ASSISTANT_ID = "asst-test";
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const toasts: Array<{ kind: "success" | "error"; message: string }> = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toasts.push({ kind: "success", message });
    },
    error: (message: string) => {
      toasts.push({ kind: "error", message });
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

interface SetCall {
  path: { assistant_id: string };
  body: {
    service: string;
    field: string;
    value: string;
    label?: string;
  };
}
const setCalls: SetCall[] = [];
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useCredentialsSetPostMutation: (
    options: UseMutationOptions<unknown, Error, SetCall> = {},
  ) =>
    useMutation<unknown, Error, SetCall>({
      mutationFn: (variables) => {
        setCalls.push(variables);
        return Promise.resolve({});
      },
      ...options,
    }),
}));

const {
  StoreCredentialDialog,
  isStorableSecret,
  rewriteDraftWithStoredCredential,
  suggestCredentialSlot,
} = await import("@/domains/chat/components/store-credential-dialog");

// Synthetic lookalike token — a random string matching the detector's
// OpenAI-project shape.
const SYNTHETIC_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A";

// Clearly fake PEM material — never a real key.
const FAKE_PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const FAKE_PEM_BODY = "MIIFAKEfakefakefakefakefakefakefakefakefake==";
const FAKE_PEM_BLOCK = `${FAKE_PEM_HEADER}\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

const fullPemSecret: DetectedSecret = {
  label: "Private Key",
  value: FAKE_PEM_BLOCK,
  start: 12,
  end: 12 + FAKE_PEM_BLOCK.length,
  wholeMessage: false,
};

const headerOnlyPemSecret: DetectedSecret = {
  label: "Private Key",
  value: FAKE_PEM_HEADER,
  start: 12,
  end: 12 + FAKE_PEM_HEADER.length,
  wholeMessage: false,
};

const detectedSecret: DetectedSecret = {
  label: "OpenAI Project Key",
  value: SYNTHETIC_PROJECT_KEY,
  start: 8,
  end: 8 + SYNTHETIC_PROJECT_KEY.length,
  wholeMessage: false,
};

const DRAFT = `here is ${SYNTHETIC_PROJECT_KEY} for the deploy`;

function renderDialog(props: Partial<StoreCredentialDialogProps> = {}) {
  const queryClient = new QueryClient();
  const onClose = mock<StoreCredentialDialogProps["onClose"]>(() => {});
  const onStored = mock<StoreCredentialDialogProps["onStored"]>(() => {});
  render(
    <QueryClientProvider client={queryClient}>
      <StoreCredentialDialog
        secret={detectedSecret}
        conversationId="conv-A"
        open
        onClose={onClose}
        onStored={onStored}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onStored };
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

beforeEach(() => {
  setCalls.length = 0;
  toasts.length = 0;
  useComposerStore.getState().setInput(DRAFT);
});

afterEach(() => {
  cleanup();
});

describe("suggestCredentialSlot", () => {
  test.each([
    ["OpenAI API Key", "openai", "api_key"],
    ["OpenAI Project Key", "openai", "api_key"],
    ["Anthropic API Key", "anthropic", "api_key"],
    ["GitHub Token", "github", "token"],
    ["GitHub Fine-Grained PAT", "github", "token"],
    ["GitLab Token", "gitlab", "token"],
    ["AWS Access Key", "aws", "access_key_id"],
    ["Stripe Secret Key", "stripe", "secret_key"],
    ["Stripe Restricted Key", "stripe", "restricted_key"],
    ["Slack Bot Token", "slack", "bot_token"],
    ["Slack User Token", "slack", "user_token"],
    ["Slack App Token", "slack", "app_token"],
    ["Telegram Bot Token", "telegram", "bot_token"],
    ["Google API Key", "google", "api_key"],
    ["Google OAuth Client Secret", "google", "oauth_client_secret"],
    ["Twilio API Key", "twilio", "api_key"],
    ["SendGrid API Key", "sendgrid", "api_key"],
    ["Mailgun API Key", "mailgun", "api_key"],
    ["npm Token", "npm", "token"],
    ["PyPI API Token", "pypi", "api_token"],
    ["Linear API Key", "linear", "api_key"],
    ["Notion Integration Token", "notion", "integration_token"],
    ["OpenRouter API Key", "openrouter", "api_key"],
    ["Vercel AI Gateway API Key", "vercel", "ai_gateway_api_key"],
    ["Fireworks API Key", "fireworks", "api_key"],
    ["Perplexity API Key", "perplexity", "api_key"],
    ["Tavily API Key", "tavily", "api_key"],
    ["Firecrawl API Key", "firecrawl", "api_key"],
  ])("%s → %s/%s", (label, service, field) => {
    expect(suggestCredentialSlot(label)).toEqual({ service, field });
  });

  test.each([
    // Owning service unknowable — the user names the slot.
    [TOKEN_SHAPE_LABEL],
    [PRIVATE_KEY_LABEL],
    // Future/unmapped detector labels degrade to empty suggestions.
    ["Some Future Vendor Key"],
    [""],
  ])("%p suggests empty fields", (label) => {
    expect(suggestCredentialSlot(label)).toEqual({ service: "", field: "" });
  });

  // Guard: the slot map is keyed by hardcoded label strings with no static
  // binding to the shared PREFIX_PATTERNS label set, so a label rename in the
  // shared module would silently degrade that pattern to an empty prefill.
  // Every prefix label except the intentionally-unmapped private key (owning
  // service unknowable) must resolve to a non-empty slot, so a rename fails
  // here instead of shipping a broken suggestion.
  test.each(
    PREFIX_PATTERNS.map((p) => p.label).filter(
      (label) => label !== PRIVATE_KEY_LABEL,
    ),
  )("%s has a slot-map entry", (label) => {
    expect(suggestCredentialSlot(label)).not.toEqual({
      service: "",
      field: "",
    });
  });
});

describe("isStorableSecret", () => {
  test("non-private-key secrets are always storable", () => {
    expect(isStorableSecret(detectedSecret)).toBe(true);
  });

  test("a complete PEM block is storable", () => {
    expect(isStorableSecret(fullPemSecret)).toBe(true);
  });

  test("a header-only private-key match is not storable", () => {
    expect(isStorableSecret(headerOnlyPemSecret)).toBe(false);
  });
});

describe("rewriteDraftWithStoredCredential", () => {
  const slot = { service: "openai", field: "api_key" };
  const placeholder = "[stored securely as openai/api_key]";

  test("replaces the secret and keeps the surrounding draft", () => {
    const rewritten = rewriteDraftWithStoredCredential(
      DRAFT,
      SYNTHETIC_PROJECT_KEY,
      slot,
    );
    expect(rewritten).toBe(`here is ${placeholder} for the deploy`);
    expect(rewritten).not.toContain(SYNTHETIC_PROJECT_KEY);
  });

  test("replaces every occurrence of the secret", () => {
    const rewritten = rewriteDraftWithStoredCredential(
      `${SYNTHETIC_PROJECT_KEY} and again ${SYNTHETIC_PROJECT_KEY}`,
      SYNTHETIC_PROJECT_KEY,
      slot,
    );
    expect(rewritten).toBe(`${placeholder} and again ${placeholder}`);
    expect(rewritten).not.toContain(SYNTHETIC_PROJECT_KEY);
  });
});

describe("StoreCredentialDialog", () => {
  test("prefills the form from the detection — the value only inside the password input", () => {
    renderDialog();

    expect(input("Service").value).toBe("openai");
    expect(input("Field").value).toBe("api_key");
    const valueInput = input("Value");
    expect(valueInput.type).toBe("password");
    expect(valueInput.value).toBe(SYNTHETIC_PROJECT_KEY);
    // Never rendered as visible text anywhere in the document (the modal
    // portals to <body>, so assert against the whole page).
    expect(document.body.textContent).not.toContain(SYNTHETIC_PROJECT_KEY);
  });

  test("save sends the exact detected value, rewrites the draft, and reports the slot", async () => {
    const { onClose, onStored } = renderDialog();

    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save" })
        .closest("form") as HTMLFormElement,
    );

    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID },
      body: {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_PROJECT_KEY,
        label: undefined,
      },
    });

    await waitFor(() => expect(onStored.mock.calls.length).toBe(1));
    expect(onStored.mock.calls[0]).toEqual([
      { service: "openai", field: "api_key" },
    ]);
    expect(onClose.mock.calls.length).toBe(1);

    const draft = useComposerStore.getState().input;
    expect(draft).toBe(
      "here is [stored securely as openai/api_key] for the deploy",
    );
    expect(draft).not.toContain(SYNTHETIC_PROJECT_KEY);
    expect(toasts).toEqual([
      {
        kind: "success",
        message: "Stored securely — the key never entered the chat",
      },
    ]);
  });

  test("the rewrite placeholder follows a user-edited service/field", async () => {
    const { onStored } = renderDialog();

    fireEvent.change(input("Service"), { target: { value: "my-openai" } });
    fireEvent.change(input("Field"), { target: { value: "main_key" } });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save" })
        .closest("form") as HTMLFormElement,
    );

    await waitFor(() => expect(onStored.mock.calls.length).toBe(1));
    expect(onStored.mock.calls[0]).toEqual([
      { service: "my-openai", field: "main_key" },
    ]);
    expect(useComposerStore.getState().input).toBe(
      "here is [stored securely as my-openai/main_key] for the deploy",
    );
  });

  test("cancel leaves the draft untouched and saves nothing", () => {
    const { onClose, onStored } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useComposerStore.getState().input).toBe(DRAFT);
    expect(setCalls.length).toBe(0);
    expect(onStored.mock.calls.length).toBe(0);
    expect(onClose.mock.calls.length).toBe(1);
  });

  // Regression: the staged secret is bound to the conversation it was
  // detected in. If the user navigates to another conversation while the
  // modal is still mounted (browser Back, deep link, sidebar switch), the
  // save must not read/rewrite whatever draft is now current — that would
  // leave conversation A's plaintext behind under a success toast, or drop
  // the placeholder into the wrong thread. The dialog cancels on switch.
  test("switching conversations while the dialog is open cancels the store action — nothing is saved and no draft is rewritten", () => {
    // Conversation A's draft holds the secret.
    useComposerStore.getState().setInput(DRAFT);
    const onStored = mock<StoreCredentialDialogProps["onStored"]>(() => {});

    // Host-faithful harness: the dialog is mounted only while a secret is
    // staged and unmounts when it requests close (mirrors the host's
    // `secretToStore` gate), and the active conversation id is switchable.
    function Harness() {
      const [queryClient] = useState(() => new QueryClient());
      const [conversationId, setConversationId] = useState("conv-A");
      const [staged, setStaged] = useState(true);
      return (
        <QueryClientProvider client={queryClient}>
          <button
            type="button"
            onClick={() => {
              setConversationId("conv-B");
            }}
          >
            switch
          </button>
          {staged && (
            <StoreCredentialDialog
              secret={detectedSecret}
              conversationId={conversationId}
              open
              onClose={() => {
                setStaged(false);
              }}
              onStored={onStored}
            />
          )}
        </QueryClientProvider>
      );
    }

    render(<Harness />);

    // Sanity: the dialog is open before the switch.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    // Switch conversations while the modal is open. The open modal marks the
    // background inert (aria-hidden), so query the switch control with
    // `hidden: true`.
    fireEvent.click(
      screen.getByRole("button", { name: "switch", hidden: true }),
    );

    // The dialog unstaged itself — Save is gone, nothing was saved, no
    // success toast fired, and no rewrite landed on the now-current thread.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(setCalls.length).toBe(0);
    expect(toasts.length).toBe(0);
    expect(onStored.mock.calls.length).toBe(0);
    // Conversation A's draft still holds its plaintext (the guard re-fires on
    // return) — the placeholder was never applied to the wrong conversation.
    expect(useComposerStore.getState().input).toBe(DRAFT);
    expect(useComposerStore.getState().input).toContain(SYNTHETIC_PROJECT_KEY);
  });

  test("a full PEM block is stored whole and rewritten out of the draft with no residue", async () => {
    const draft = `here is my\n${FAKE_PEM_BLOCK}\nplease deploy`;
    useComposerStore.getState().setInput(draft);
    const { onStored } = renderDialog({ secret: fullPemSecret });

    fireEvent.change(input("Service"), { target: { value: "github-app" } });
    fireEvent.change(input("Field"), { target: { value: "pem" } });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save" })
        .closest("form") as HTMLFormElement,
    );

    // The mutation receives the ENTIRE block — header, body, and footer.
    await waitFor(() => expect(setCalls.length).toBe(1));
    expect(setCalls[0]!.body.value).toBe(FAKE_PEM_BLOCK);

    await waitFor(() => expect(onStored.mock.calls.length).toBe(1));
    const rewritten = useComposerStore.getState().input;
    expect(rewritten).toBe(
      "here is my\n[stored securely as github-app/pem]\nplease deploy",
    );
    // No fragment of the key survives anywhere — draft or DOM.
    expect(rewritten).not.toContain("BEGIN");
    expect(rewritten).not.toContain(FAKE_PEM_BODY);
    expect(rewritten).not.toContain("END");
    expect(document.body.innerHTML).not.toContain(FAKE_PEM_BODY);
  });

  test("a header-only private-key match is not storable — the dialog never opens", () => {
    // A partial store would vault just the header and strip only the header
    // from the draft, leaving the key body behind with nothing left for the
    // detector to flag.
    useComposerStore
      .getState()
      .setInput(`here is my\n${FAKE_PEM_HEADER}\n${FAKE_PEM_BODY}`);
    renderDialog({ secret: headerOnlyPemSecret });

    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("unknown detection label opens with empty service/field for the user to fill", () => {
    renderDialog({
      secret: {
        label: TOKEN_SHAPE_LABEL,
        value: SYNTHETIC_PROJECT_KEY,
        start: 0,
        end: SYNTHETIC_PROJECT_KEY.length,
        wholeMessage: true,
      },
    });

    expect(input("Service").value).toBe("");
    expect(input("Field").value).toBe("");
    expect(input("Value").value).toBe(SYNTHETIC_PROJECT_KEY);
  });
});
