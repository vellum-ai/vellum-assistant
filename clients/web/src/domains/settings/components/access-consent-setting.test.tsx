/**
 * Tests for `AccessConsentSetting`.
 *
 * The toggle must address the assistant this settings page is showing. The
 * id-less `/assistants/access-consent/` endpoint lets the server pick "the
 * user's presumably unique assistant", which for a user with several can be
 * a different one from the one on screen. So: read and write go through
 * `/v1/assistants/{id}/access-consent/` with the active assistant id, and
 * with no active id the toggle stays disabled and nothing is requested.
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

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "019d3011-97c7-7541-b49a-ef11aaedfe79";

interface RequestArgs {
  url: string;
  path?: { id?: string };
  body?: { access_consented?: boolean; never_expires?: boolean };
}

let consented = false;
// Set by tests that start with an active grant; PATCH true restarts it.
let expiresAt: string | null = null;
let neverExpires = false;
// A platform from before the override omits the field entirely.
let platformSupportsKeepOn = true;
function consentPayload() {
  return {
    access_consented: consented,
    access_consent_expires_at: consented && !neverExpires ? expiresAt : null,
    ...(platformSupportsKeepOn
      ? { access_consent_never_expires: consented && neverExpires }
      : {}),
  };
}
const getCalls: RequestArgs[] = [];
const patchCalls: RequestArgs[] = [];
// When `release` is null, PATCH responses wait until the test releases
// them, so a test can change the active assistant while a write is still in
// flight. Held in an object so TypeScript does not narrow it across awaits.
const patchGate: { release: (() => void) | null } = { release: () => {} };
// Read through a function so TypeScript does not narrow `release` to null
// across the awaits between the assignment and the call.
function currentRelease(): (() => void) | null {
  return patchGate.release;
}

mock.module("@/generated/api/client.gen", () => ({
  client: {
    get: async (args: RequestArgs) => {
      getCalls.push(args);
      return { data: consentPayload(), response: new Response() };
    },
    patch: async (args: RequestArgs) => {
      patchCalls.push(args);
      if (patchGate.release === null) {
        await new Promise<void>((resolve) => {
          patchGate.release = resolve;
        });
      }
      consented = args.body?.access_consented ?? consented;
      neverExpires = consented && args.body?.never_expires === true;
      if (consented) {
        expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      }
      return { data: consentPayload(), response: new Response() };
    },
    getConfig: () => ({ baseUrl: "http://test.local" }),
  },
}));

let selfHosted = false;
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsSelfHosted: () => selfHosted,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

// Local-mode ids are lockfile slugs; the platform wants the registered
// UUID. Stand in the resolver: a UUID resolves to itself (as the real one
// does, without a network round-trip) and a slug maps to ASSISTANT_ID.
const UUID_RE = /^[0-9a-f-]{36}$/i;
const resolvedFor: string[] = [];
mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: (id: string | null) => {
    if (id) {
      resolvedFor.push(id);
    }
    return {
      platformAssistantId: id ? (UUID_RE.test(id) ? id : ASSISTANT_ID) : null,
      isLoading: false,
      error: null,
    };
  },
}));

// The export row is its own component with its own tests; here only its
// presence matters.
mock.module("@/domains/settings/components/debug-bundle-export", () => ({
  DebugBundleExport: ({ assistantId }: { assistantId: string }) => (
    <div data-testid="debug-bundle-export">{assistantId}</div>
  ),
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
}));

import { AccessConsentSetting } from "@/domains/settings/components/access-consent-setting";

// This repo's bun tests do not load jest-dom matchers, so read the DOM
// directly. The Toggle is a button; either the attribute or aria form counts.
function isDisabled(element: HTMLElement): boolean {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  );
}

function renderSetting() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessConsentSetting />
    </QueryClientProvider>,
  );
}

describe("AccessConsentSetting", () => {
  beforeEach(() => {
    consented = false;
    expiresAt = null;
    neverExpires = false;
    platformSupportsKeepOn = true;
    selfHosted = false;
    resolvedFor.length = 0;
    getCalls.length = 0;
    patchCalls.length = 0;
    patchGate.release = () => {};
    useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  });

  afterEach(() => {
    cleanup();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  });

  test("reads consent for the active assistant by id", async () => {
    renderSetting();

    await waitFor(() => expect(getCalls).toHaveLength(1));
    expect(getCalls[0].url).toBe("/v1/assistants/{id}/access-consent/");
    expect(getCalls[0].path?.id).toBe(ASSISTANT_ID);
  });

  test("writes consent for the active assistant by id", async () => {
    renderSetting();

    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(isDisabled(toggle)).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].url).toBe("/v1/assistants/{id}/access-consent/");
    expect(patchCalls[0].path?.id).toBe(ASSISTANT_ID);
    expect(patchCalls[0].body).toEqual({ access_consented: true });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  test("a PATCH that settles after switching assistants is cached under the assistant it was sent for", async () => {
    const OTHER_ID = "019d3011-97c7-7541-b49a-000000000000";
    renderSetting();

    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(isDisabled(toggle)).toBe(false));

    // Hold the PATCH open, click, then switch the active assistant.
    patchGate.release = null;
    fireEvent.click(toggle);
    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].path?.id).toBe(ASSISTANT_ID);
    useResolvedAssistantsStore.getState().setActiveAssistantId(OTHER_ID);

    // Let the original write settle.
    await waitFor(() => expect(currentRelease()).not.toBeNull());
    currentRelease()?.();

    // The response belongs to the first assistant. The second assistant's
    // query fetched its own value (false) and must not inherit true.
    await waitFor(() =>
      expect(getCalls.some((call) => call.path?.id === OTHER_ID)).toBe(true),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });

  test("an active grant shows when it ends and can be extended", async () => {
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    renderSetting();

    await screen.findByText("Staff access ends in 3 hours.");
    fireEvent.click(screen.getByRole("button", { name: "Extend 24 hours" }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].path?.id).toBe(ASSISTANT_ID);
    expect(patchCalls[0].body).toEqual({ access_consented: true });
    await screen.findByText("Staff access ends in 24 hours.");
  });

  test("the owner can keep access on until they turn it off, and put the clock back", async () => {
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    renderSetting();

    await screen.findByText("Staff access ends in 3 hours.");
    fireEvent.click(
      screen.getByRole("button", { name: "Keep on until I turn it off" }),
    );

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].body).toEqual({
      access_consented: true,
      never_expires: true,
    });
    await screen.findByText("Staff access stays on until you turn it off.");
    expect(screen.queryByText(/Staff access ends/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expire after 24 hours" }),
    );
    await waitFor(() => expect(patchCalls).toHaveLength(2));
    expect(patchCalls[1].body).toEqual({ access_consented: true });
    await screen.findByText("Staff access ends in 24 hours.");
  });

  test("hides keep-on when the platform predates it, so a click can never send an unsupported field", async () => {
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    platformSupportsKeepOn = false;
    renderSetting();

    await screen.findByText("Staff access ends in 3 hours.");
    expect(
      screen.getByRole("button", { name: "Extend 24 hours" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Keep on until I turn it off" }),
    ).toBeNull();
  });

  test("an open tab refetches when the grant lapses and shows the toggle off", async () => {
    consented = true;
    expiresAt = new Date(Date.now() + 1_500).toISOString();
    renderSetting();

    const toggle = await screen.findByRole("switch");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(getCalls).toHaveLength(1);

    // The server now reports the grant as lapsed; the page must ask again.
    consented = false;
    await waitFor(() => expect(getCalls.length).toBeGreaterThan(1), {
      timeout: 5_000,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      screen.queryByRole("button", { name: "Extend 24 hours" }),
    ).toBeNull();
  });

  test("with no active assistant the toggle is disabled and nothing is requested", async () => {
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
    renderSetting();

    const toggle = await screen.findByRole("switch");
    expect(isDisabled(toggle)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  test("a self-hosted assistant gets the same toggle, plus the export row while the grant is on", async () => {
    selfHosted = true;
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    renderSetting();

    await screen.findByText("Staff access ends in 3 hours.");
    expect(screen.getByTestId("debug-bundle-export").textContent).toBe(
      ASSISTANT_ID,
    );
    expect(getCalls[0]?.path?.id).toBe(ASSISTANT_ID);
  });

  test("the export row is absent while the grant is off, and for hosted assistants", async () => {
    selfHosted = true;
    renderSetting();
    await waitFor(() => expect(getCalls).toHaveLength(1));
    expect(screen.queryByTestId("debug-bundle-export")).toBeNull();

    cleanup();
    selfHosted = false;
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    renderSetting();
    await screen.findByText("Staff access ends in 3 hours.");
    expect(screen.queryByTestId("debug-bundle-export")).toBeNull();
  });

  test("a local-mode slug is resolved to the platform UUID before any platform call", async () => {
    selfHosted = true;
    consented = true;
    expiresAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    useResolvedAssistantsStore
      .getState()
      .setActiveAssistantId("vellum-dark-cub");
    renderSetting();

    await screen.findByText("Staff access ends in 3 hours.");
    expect(resolvedFor).toContain("vellum-dark-cub");
    expect(getCalls[0]?.path?.id).toBe(ASSISTANT_ID);
    expect(screen.getByTestId("debug-bundle-export").textContent).toBe(
      ASSISTANT_ID,
    );

    fireEvent.click(screen.getByRole("button", { name: "Extend 24 hours" }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].path?.id).toBe(ASSISTANT_ID);
  });
});
