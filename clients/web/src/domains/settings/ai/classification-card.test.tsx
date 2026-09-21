/**
 * Tests for `ClassificationCard`: the provider list comes from the daemon's
 * classification catalog, Save with a typed key writes the credential and
 * `services.classification`, and choosing Vellum writes the managed mode
 * without touching the credential store.
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
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

const TYPESAFE = {
  id: "typesafe",
  displayName: "TypeSafe",
  subtitle: "TypeSafe System One decision model.",
  setupMode: "api-key",
  setupHint: "Enter your TypeSafe API key to enable Jev.",
  apiKeyProviderName: "typesafe",
  defaultModel: "jev-latest",
  models: [{ id: "jev-latest", displayName: "Jev" }],
  supportsManaged: true,
  credentialsGuide: {
    description: "Sign in to TypeSafe and create an API key.",
    url: "https://typesafe.ai",
    linkLabel: "Open TypeSafe",
  },
};
interface CatalogData {
  providers: (typeof TYPESAFE)[];
  availability: {
    available: boolean;
    mode: "managed" | "your-own";
    providerId: string;
    model: string;
    source?: "user-key" | "managed-proxy";
    reason?: string;
  };
}
let catalogData: CatalogData = {
  providers: [TYPESAFE],
  availability: {
    available: false,
    mode: "your-own",
    providerId: "typesafe",
    model: "jev-latest",
    reason: "missing_credential",
  },
};
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  classificationProvidersGetOptions: () => ({
    queryKey: ["classification-providers-test"],
    queryFn: () => Promise.resolve(catalogData),
    initialData: catalogData,
  }),
  classificationProvidersGetQueryKey: () => ["classification-providers-test"],
}));

interface SdkCall {
  path?: unknown;
  body?: unknown;
  throwOnError?: boolean;
}
const credentialsSetCalls: SdkCall[] = [];
const configPatchCalls: SdkCall[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  credentialsSetPost: (opts: SdkCall) => {
    credentialsSetCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
  configPatch: (opts: SdkCall) => {
    configPatchCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
}));

const { ClassificationCard } =
  await import("@/domains/settings/ai/classification-card");
const { changeLocale } = await import("@/i18n");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClassificationCard />
    </QueryClientProvider>,
  );
}

function openSelect(ariaLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected the "${ariaLabel}" dropdown trigger`);
  }
  fireEvent.click(trigger);
}

function visibleOptions(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

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

describe("ClassificationCard", () => {
  beforeEach(async () => {
    await changeLocale("en");
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    catalogData = {
      providers: [TYPESAFE],
      availability: {
        available: false,
        mode: "your-own",
        providerId: "typesafe",
        model: "jev-latest",
        reason: "missing_credential",
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("lists the daemon catalog providers and reports the missing key", () => {
    renderCard();

    openSelect("Classification provider");
    expect(visibleOptions()).toContain("TypeSafe");
    expect(screen.getByText("Add an API key to turn this on.")).toBeTruthy();
  });

  test("saving a typed key stores the credential and writes services.classification", async () => {
    renderCard();

    fireEvent.change(screen.getByPlaceholderText("Your TypeSafe API key"), {
      target: { value: "sk-typesafe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });
    expect(credentialsSetCalls).toEqual([
      {
        path: { assistant_id: ASSISTANT_ID },
        body: {
          service: "typesafe",
          field: "api_key",
          value: "sk-typesafe",
          label: "TypeSafe API Key",
        },
        throwOnError: false,
      },
    ]);
    expect(configPatchCalls[0]?.body).toEqual({
      services: {
        classification: {
          mode: "your-own",
          provider: "typesafe",
          model: "jev-latest",
        },
      },
    });
  });

  test("choosing Vellum writes the managed mode without a credential write", async () => {
    renderCard();

    openSelect("Classification mode");
    selectOption("Vellum");
    expect(screen.queryByText("API Key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });
    expect(credentialsSetCalls.length).toBe(0);
    expect(configPatchCalls[0]?.body).toEqual({
      services: {
        classification: {
          mode: "managed",
          provider: "typesafe",
          model: "jev-latest",
        },
      },
    });
  });

  test("a managed daemon config renders as Vellum and Save stays disabled until something changes", () => {
    daemonConfigData = {
      services: {
        classification: {
          mode: "managed",
          provider: "typesafe",
          model: "jev-latest",
        },
      },
    };
    catalogData = {
      ...catalogData,
      availability: {
        available: true,
        mode: "managed",
        providerId: "typesafe",
        model: "jev-latest",
        source: "managed-proxy",
      },
    };
    renderCard();

    expect(screen.getByText("Running through Vellum.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
