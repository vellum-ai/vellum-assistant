import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const postCalls: Array<Record<string, unknown>> = [];
const patchCalls: Array<Record<string, unknown>> = [];
const getCalls: Array<Record<string, unknown>> = [];

const client = {
  get: mock(async (options: Record<string, unknown>) => {
    getCalls.push(options);
    return {
      data: {
        services: {
          tts: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                voiceId: "saved-voice",
              },
            },
          },
        },
      },
    };
  }),
  patch: mock(async (options: Record<string, unknown>) => {
    patchCalls.push(options);
    return { data: { ok: true } };
  }),
  post: mock(async (options: Record<string, unknown>) => {
    postCalls.push(options);
    if (String(options.url).includes("/credentials/inspect")) {
      return { data: { hasSecret: false } };
    }
    if (String(options.url).includes("/tts/synthesize-cli")) {
      return { data: { audioBase64: "AQID", contentType: "audio/mpeg" } };
    }
    return { data: { ok: true, credentialId: "cred-1" } };
  }),
};

mock.module("@/generated/api/client.gen", () => ({ client }));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsDomainsCreateMutation: () => ({}),
  assistantsDomainsDestroyMutation: () => ({}),
  assistantsDomainsListOptions: () => ({
    queryKey: ["assistant-domains"],
    queryFn: async () => ({ results: [] }),
  }),
  assistantsDomainsListQueryKey: () => ["assistant-domains"],
  assistantsDomainsVerificationStatusRetrieveOptions: () => ({
    queryKey: ["assistant-domain-status"],
    queryFn: async () => ({}),
  }),
  assistantsEmailAddressesCreateMutation: () => ({}),
  assistantsEmailAddressesDestroyMutation: () => ({}),
  assistantsEmailAddressesListOptions: () => ({
    queryKey: ["assistant-email-addresses"],
    queryFn: async () => ({ results: [] }),
  }),
  assistantsEmailAddressesListQueryKey: () => ["assistant-email-addresses"],
  assistantsEmailAddressesStatusRetrieveOptions: () => ({
    queryKey: ["assistant-email-address-status"],
    queryFn: async () => ({}),
  }),
  assistantsEmailAddressesStatusRetrieveQueryKey: () => [
    "assistant-email-address-status",
  ],
  assistantsListOptions: () => ({
    queryKey: ["assistants"],
    queryFn: async () => ({
      results: [{ id: "asst-1", name: "Example Assistant" }],
    }),
  }),
  assistantsListQueryKey: () => ["assistants"],
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: ["subscription"],
    queryFn: async () => ({ plan_id: "base", status: "active" }),
  }),
}));

mock.module("@/utils/error-report", () => ({
  reportError: () => {},
}));

mock.module("@vellum/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  } & Record<string, unknown>) =>
    createElement("button", { onClick, disabled, ...props }, children),
}));

mock.module("@vellum/design-library/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

mock.module("@vellum/design-library/components/dropdown", () => ({
  Dropdown: ({
    value,
    onChange,
    options,
    "aria-label": ariaLabel,
    ariaLabel: ariaLabelProp,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    options?: Array<{ value: string; label: string }>;
    "aria-label"?: string;
    ariaLabel?: string;
  }) =>
    createElement(
      "select",
      {
        "aria-label": ariaLabel ?? ariaLabelProp ?? "Select",
        value,
        onChange: (event: { target: { value: string } }) =>
          onChange?.(event.target.value),
      },
      ...(options ?? []).map((option) =>
        createElement("option", { key: option.value, value: option.value }, option.label),
      ),
    ),
}));

mock.module("@vellum/design-library/components/input", () => ({
  Input: ({
    label,
    type,
    value,
    onChange,
    placeholder,
  }: {
    label?: string;
    type?: string;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    placeholder?: string;
  }) =>
    createElement("input", {
      "aria-label":
        label ?? (type === "password" ? "API Key" : placeholder === "Enter a voice ID" ? "Voice ID" : placeholder),
      type,
      value,
      placeholder,
      onChange,
    }),
  Textarea: ({
    label,
    value,
    onChange,
    placeholder,
  }: {
    label?: string;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    placeholder?: string;
  }) =>
    createElement("textarea", {
      "aria-label": label ?? placeholder,
      value,
      placeholder,
      onChange,
    }),
}));

mock.module("@vellum/design-library/components/modal", () => ({
  Modal: ({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) =>
    isOpen ? createElement("div", null, children) : null,
}));

mock.module("@vellum/design-library/components/notice", () => ({
  Notice: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));

mock.module("@vellum/design-library/components/segment-control", () => ({
  SegmentControl: () => null,
}));

mock.module("@vellum/design-library/components/slider", () => ({
  Slider: () => null,
}));

mock.module("@vellum/design-library/components/tag", () => ({
  Tag: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

mock.module("@vellum/design-library/components/toggle", () => ({
  Toggle: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      checked,
      onChange: (event: { target: { checked: boolean } }) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

mock.module("@vellum/design-library/components/toast", () => ({
  toast: {
    success: mock(() => {}),
    error: mock(() => {}),
  },
}));

mock.module("@vellum/design-library/components/typography", () => ({
  Typography: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));

mock.module("@/components/detail-card", () => ({
  DetailCard: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "section",
      { role: "region", "aria-label": title },
      createElement("h2", null, title),
      subtitle ? createElement("p", null, subtitle) : null,
      children,
    ),
}));

mock.module("@/domains/settings/components/domain-field", () => ({
  DomainField: () => null,
}));

mock.module("@/domains/settings/ai/call-site-overrides-modal", () => ({
  CallSiteOverridesModal: () => null,
}));

mock.module("@/domains/settings/ai/manage-profiles-modal", () => ({
  ManageProfilesModal: () => null,
}));

mock.module("@/domains/settings/ai/manage-providers-modal", () => ({
  ManageProvidersModal: () => null,
}));

const { TextToSpeechCard } = await import("@/domains/settings/ai/ai-page");

function renderTextToSpeechCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TextToSpeechCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  postCalls.length = 0;
  patchCalls.length = 0;
  getCalls.length = 0;
  client.get.mockClear();
  client.post.mockClear();
  client.patch.mockClear();
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  globalThis.Audio = originalAudio;
});

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const originalAudio = globalThis.Audio;

function installAudioMocks() {
  URL.createObjectURL = mock(() => "blob:test-tts");
  URL.revokeObjectURL = mock(() => {});
  globalThis.Audio = class {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {}

    async play() {
      this.onended?.();
    }
  } as unknown as typeof Audio;
}

describe("TextToSpeechCard", () => {
  test("saves TTS credentials and voice config through the assistant runtime", async () => {
    renderTextToSpeechCard();

    const card = await screen.findByRole("region", {
      name: "Text-to-Speech",
    });

    await waitFor(() => {
      expect(getCalls.some((call) => String(call.url).includes("/config"))).toBe(
        true,
      );
    });

    fireEvent.change(within(card).getByLabelText("API Key"), {
      target: { value: "sk-test-runtime" },
    });
    fireEvent.change(within(card).getByLabelText("Voice ID"), {
      target: { value: "runtime-voice" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        postCalls.some((call) =>
          String(call.url).includes("/credentials/set"),
        ),
      ).toBe(true);
    });

    const credentialCall = postCalls.find((call) =>
      String(call.url).includes("/credentials/set"),
    );
    expect(credentialCall?.body).toEqual({
      service: "elevenlabs",
      field: "api_key",
      value: "sk-test-runtime",
      label: "ElevenLabs API Key",
      description: "Text-to-speech API key for ElevenLabs",
    });

    expect(patchCalls[0]?.body).toEqual({
      services: {
        tts: {
          mode: "your-own",
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              voiceId: "runtime-voice",
            },
          },
        },
      },
    });
    expect(localStorage.getItem("vellum:voice:ttsApiKey:elevenlabs")).toBeNull();
    expect(localStorage.getItem("vellum:voice:ttsVoiceId:elevenlabs")).toBeNull();
  });

  test("tests TTS through the assistant runtime after saving pending values", async () => {
    installAudioMocks();
    renderTextToSpeechCard();

    const card = await screen.findByRole("region", {
      name: "Text-to-Speech",
    });

    fireEvent.change(within(card).getByLabelText("API Key"), {
      target: { value: "sk-test-runtime" },
    });
    fireEvent.change(within(card).getByLabelText("Voice ID"), {
      target: { value: "runtime-voice" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(
        postCalls.some((call) =>
          String(call.url).includes("/tts/synthesize-cli"),
        ),
      ).toBe(true);
    });

    const synthesizeCall = postCalls.find((call) =>
      String(call.url).includes("/tts/synthesize-cli"),
    );
    expect(synthesizeCall?.body).toEqual({
      text: "Hey! It's Example Assistant. How does this sound?",
      useCase: "message-playback",
    });
    expect(
      postCalls.some((call) => String(call.url).includes("/credentials/set")),
    ).toBe(true);
    expect(patchCalls[0]?.body).toEqual({
      services: {
        tts: {
          mode: "your-own",
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              voiceId: "runtime-voice",
            },
          },
        },
      },
    });
  });
});
