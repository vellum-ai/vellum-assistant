/**
 * Tests for `ClassificationCard`: the provider list comes from the daemon's
 * classification catalog, Save with a typed key validates and stores it
 * through the provider-aware secrets route before writing
 * `services.classification`, a rejected key leaves the config untouched,
 * choosing Vellum writes the managed mode without a key write, and an
 * assistant without the catalog route renders no card at all.
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
const toastErrors: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
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
// `catalogStatus` 404 simulates an assistant that predates the route.
let catalogStatus: 200 | 404 = 200;
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  classificationProvidersGetQueryKey: () => ["classification-providers-test"],
}));

interface SdkCall {
  path?: unknown;
  body?: unknown;
  throwOnError?: boolean;
  signal?: unknown;
}
const secretsPostCalls: SdkCall[] = [];
const configPatchCalls: SdkCall[] = [];
// What the daemon answers on the secrets route: success, or a
// provider-rejected key (200 with success:false, nothing stored).
let secretsPostResult: { success: boolean; error?: string } = {
  success: true,
};
mock.module("@/generated/daemon/sdk.gen", () => ({
  classificationProvidersGet: () =>
    Promise.resolve(
      catalogStatus === 404
        ? { data: undefined, error: {}, response: { ok: false, status: 404 } }
        : { data: catalogData, response: { ok: true, status: 200 } },
    ),
  secretsPost: (opts: SdkCall) => {
    secretsPostCalls.push(opts);
    return Promise.resolve({
      data: secretsPostResult,
      response: { ok: true, status: 200 },
    });
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
    secretsPostCalls.length = 0;
    configPatchCalls.length = 0;
    secretsPostResult = { success: true };
    catalogStatus = 200;
    toastErrors.length = 0;
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

  test("lists the daemon catalog providers and reports the missing key", async () => {
    renderCard();

    await screen.findByText("Add an API key to turn this on.");
    openSelect("Classification provider");
    expect(visibleOptions()).toContain("TypeSafe");
  });

  test("renders nothing when the assistant predates the catalog route", async () => {
    catalogStatus = 404;
    const { container } = renderCard();

    // Let the 404-mapped query settle; the feature-off state is no card.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Classification")).toBeNull();
  });

  test("saving a typed key validates it through the secrets route, then writes services.classification", async () => {
    renderCard();

    fireEvent.change(
      await screen.findByPlaceholderText("Your TypeSafe API key"),
      { target: { value: "sk-typesafe" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });
    expect(secretsPostCalls).toEqual([
      {
        path: { assistant_id: ASSISTANT_ID },
        body: { type: "api_key", name: "typesafe", value: "sk-typesafe" },
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

  test("a key the provider rejects is surfaced and the config is left untouched", async () => {
    secretsPostResult = { success: false, error: "TypeSafe rejected the key" };
    renderCard();

    fireEvent.change(
      await screen.findByPlaceholderText("Your TypeSafe API key"),
      { target: { value: "sk-bad" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(secretsPostCalls.length).toBe(1);
    });
    // Save settles (the button re-enables) with no config write behind it.
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(configPatchCalls.length).toBe(0);
    expect(toastErrors).toEqual(["TypeSafe rejected the key"]);
  });

  test("choosing Vellum writes the managed mode without a key write", async () => {
    renderCard();

    await screen.findByText("Add an API key to turn this on.");
    openSelect("Classification mode");
    selectOption("Vellum");
    expect(screen.queryByText("API Key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });
    expect(secretsPostCalls.length).toBe(0);
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

  test("a managed daemon config renders as Vellum and Save stays disabled until something changes", async () => {
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

    await screen.findByText("Running through Vellum.");
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
