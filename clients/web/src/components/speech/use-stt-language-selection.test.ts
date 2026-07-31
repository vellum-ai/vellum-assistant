/**
 * Tests for `useSttLanguageSelection`:
 *
 *   1. Capability gating: unavailable when the daemon omits
 *      `languageSelection` (old daemon) or reports the configured provider
 *      as `"auto"`; available for a `"manual"` provider.
 *   2. Writes: a pick issues exactly one `services.stt.language` PATCH;
 *      rapid picks serialize in call order; the default pick writes the
 *      explicit `"en"` fallback (config_patch cannot delete the key) and
 *      `"en"` reads back as the default code.
 *   3. Provider scoping of that read equivalence: under xai, whose unset
 *      state means native auto-detection, a persisted `"en"` is a real pin
 *      and reads back as itself.
 *
 * Generated daemon bindings are mocked with controllable data, mirroring
 * `speech-to-text-card.test.tsx`; the QueryClientProvider is real.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

const ASSISTANT_ID = "asst-test";

// Controllable daemon responses the mocked query factories resolve to.
// `initialData` makes them available synchronously on mount, mirroring how
// the real queries would already be cached.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
let providerCatalogData: {
  providers: {
    id: string;
    displayName: string;
    languageSelection?: "manual" | "auto";
  }[];
} = { providers: [] };
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  sttProvidersGetOptions: () => ({
    queryKey: ["stt-providers-test"],
    queryFn: () => Promise.resolve(providerCatalogData),
    initialData: providerCatalogData,
  }),
}));

// Capture the language PATCHes. `deferPatches` switches configPatch to
// manually-resolved promises so the serialization test can observe ordering.
interface SdkCall {
  path?: unknown;
  body?: unknown;
}
const configPatchCalls: SdkCall[] = [];
let deferPatches = false;
let patchResolvers: ((v: {
  response: { ok: boolean; status: number };
}) => void)[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  configPatch: (opts: SdkCall) => {
    configPatchCalls.push(opts);
    if (deferPatches) {
      return new Promise((resolve) => patchResolvers.push(resolve));
    }
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
}));

const { useSttLanguageSelection } =
  await import("@/components/speech/use-stt-language-selection");

function renderSelection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useSttLanguageSelection(ASSISTANT_ID), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

describe("useSttLanguageSelection", () => {
  beforeEach(() => {
    configPatchCalls.length = 0;
    deferPatches = false;
    patchResolvers = [];
    daemonConfigData = { services: {} };
    providerCatalogData = { providers: [] };
  });

  test("unavailable when the daemon omits languageSelection (old daemon)", () => {
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [{ id: "deepgram", displayName: "Deepgram" }],
    };

    const { result } = renderSelection();
    expect(result.current.available).toBe(false);
  });

  test("unavailable when the configured provider auto-detects", () => {
    daemonConfigData = { services: { stt: { provider: "google-gemini" } } };
    providerCatalogData = {
      providers: [
        {
          id: "google-gemini",
          displayName: "Gemini",
          languageSelection: "auto",
        },
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.available).toBe(false);
  });

  test("available for a manually language-selectable provider", () => {
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.available).toBe(true);
    expect(result.current.currentCode).toBe("");
  });

  test("exposes the configured provider id, mapping legacy managed mode", () => {
    // Surfaces build their option list from this, so the config narrowing
    // (managed-mode aliasing, the schema-default fallback) lives here once.
    daemonConfigData = {
      services: { stt: { mode: "managed", provider: "deepgram" } },
    };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.configuredProviderId).toBe("vellum");
    expect(result.current.available).toBe(true);
  });

  test("an unset provider reads as the daemon schema default", () => {
    daemonConfigData = { services: {} };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.configuredProviderId).toBe("deepgram");
    expect(result.current.available).toBe(true);
  });

  test("a pick issues one services.stt.language PATCH", async () => {
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    act(() => result.current.selectLanguage("multi"));

    expect(result.current.currentCode).toBe("multi");
    await waitFor(() => expect(result.current.selecting).toBe(false));
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0]!.path).toEqual({ assistant_id: ASSISTANT_ID });
    expect(configPatchCalls[0]!.body).toEqual({
      services: { stt: { language: "multi" } },
    });
  });

  test("two rapid picks serialize in call order", async () => {
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };
    deferPatches = true;

    const { result } = renderSelection();
    act(() => result.current.selectLanguage("multi"));
    act(() => result.current.selectLanguage("es"));

    // The second write waits for the first to settle.
    await waitFor(() => expect(configPatchCalls).toHaveLength(1));
    expect(configPatchCalls).toHaveLength(1);
    expect(result.current.currentCode).toBe("es");

    act(() => patchResolvers[0]!({ response: { ok: true, status: 200 } }));
    await waitFor(() => expect(configPatchCalls).toHaveLength(2));
    expect(configPatchCalls[0]!.body).toEqual({
      services: { stt: { language: "multi" } },
    });
    expect(configPatchCalls[1]!.body).toEqual({
      services: { stt: { language: "es" } },
    });
    expect(result.current.selecting).toBe(true);

    act(() => patchResolvers[1]!({ response: { ok: true, status: 200 } }));
    await waitFor(() => expect(result.current.selecting).toBe(false));
  });

  test("the default pick writes explicit en, and en reads as the default code", async () => {
    daemonConfigData = {
      services: { stt: { provider: "vellum", language: "multi" } },
    };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.currentCode).toBe("multi");

    // config_patch cannot delete the key (a null leaf breaks schema
    // validation on the next load), so the default pick writes "en".
    daemonConfigData = {
      services: { stt: { provider: "vellum", language: "en" } },
    };
    act(() => result.current.selectLanguage(""));

    await waitFor(() => expect(result.current.selecting).toBe(false));
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0]!.body).toEqual({
      services: { stt: { language: "en" } },
    });
    // The refetched config holds "en"; the hook reads it as the default code.
    await waitFor(() => expect(result.current.currentCode).toBe(""));
  });

  test("en reads as itself under xai, whose unset state means auto-detect", () => {
    // Under xai the default row renders "Auto-detect", so collapsing a
    // persisted "en" into it would misreport a real English pin as
    // auto-detection. The display equivalence stays scoped to providers
    // whose unset state decodes as English.
    daemonConfigData = {
      services: { stt: { provider: "xai", language: "en" } },
    };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.currentCode).toBe("en");
    expect(result.current.configuredProviderId).toBe("xai");
  });

  test("unset language under xai reads as the default (auto-detect) code", () => {
    daemonConfigData = { services: { stt: { provider: "xai" } } };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };

    const { result } = renderSelection();
    expect(result.current.currentCode).toBe("");
  });
});
