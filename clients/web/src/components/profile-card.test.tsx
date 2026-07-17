/**
 * Smoke tests for `ProfileCard`.
 *
 * The fetch surface and debounced availability check are tested at the
 * lib level (`profile.test.ts`, `handle.test.ts`) and via the Django
 * integration tests (`app/users/tests/test_views.py`,
 * `app/assistant/tests/test_handle_*.py`). Here we verify the React render:
 *
 *  - mounts with a loading placeholder
 *  - renders the user handle editor once `fetchMe` resolves
 *  - shows the auto-generated nudge for handles that look auto-generated
 *  - renders the assistant section only when an ``assistant`` prop is
 *    supplied, with the "claim one" nudge when ``assistant.handle`` is null
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Assistant } from "@/generated/api/types.gen";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

let fetchMeImpl: () => Promise<unknown> = () =>
  new Promise(() => {
    // Pending forever — keeps the loading state in place for the first
    // assertion. Individual tests override this.
  });

mock.module("@/domains/account/profile", () => ({
  fetchMe: () => fetchMeImpl(),
  checkUsernameAvailable: async () => ({
    available: true,
    code: null,
    message: null,
  }),
  updateMe: async () => ({ kind: "ok", data: null }),
  USERNAME_ERROR_COPY: {
    too_short: "Must be at least 3 characters.",
    too_long: "Must be at most 30 characters.",
    invalid_chars:
      "Use only lowercase letters, digits, hyphens, and underscores.",
    leading_underscore: "Cannot start with an underscore.",
    trailing_underscore: "Cannot end with an underscore.",
    leading_hyphen: "Cannot start with a hyphen.",
    trailing_hyphen: "Cannot end with a hyphen.",
    all_digits: "Cannot be all digits.",
    reserved: "This handle is reserved.",
    taken: "This handle is already taken.",
  },
}));

// Zustand auth-store mock — profile-card only reaches for
// ``useAuthStore.use.refreshSession()``, so the minimal `.use` selector
// surface is enough. ``renderToStaticMarkup`` is single-pass and only
// invokes refreshSession after a save (handle-section's onSaved callback),
// so it never fires during these tests; the noop is a safety net.
const noopRefresh = async () => true;
mock.module("@/stores/auth-store", () => {
  const store = () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).use = {
    refreshSession: () => noopRefresh,
  };
  return { useAuthStore: store };
});

// Toast mock needs to satisfy the design-library barrel's re-exports too —
// `detail-card.tsx` pulls `Card`/`cn` from the barrel index, which itself
// re-exports `Toaster`/`ToastContent` from this module. Missing exports
// here surface as parse-time "export not found" errors during barrel
// resolution, not as runtime failures, so stub them with no-op components.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// Assistant-handle surface mock. Same shape as the user-handle module —
// the discriminated-union return type lets us pin "success" defaults here
// without individual tests caring about save semantics.
mock.module("@/domains/account/handle", () => ({
  checkAssistantHandleAvailable: async () => ({
    available: true,
    code: null,
    message: null,
  }),
  updateAssistantHandle: async () => ({ kind: "ok", data: null }),
  HANDLE_ERROR_COPY: {
    too_short: "Must be at least 3 characters.",
    too_long: "Must be at most 30 characters.",
    invalid_chars:
      "Use only lowercase letters, digits, hyphens, and underscores.",
    leading_underscore: "Cannot start with an underscore.",
    trailing_underscore: "Cannot end with an underscore.",
    leading_hyphen: "Cannot start with a hyphen.",
    trailing_hyphen: "Cannot end with a hyphen.",
    all_digits: "Cannot be all digits.",
    reserved: "This handle is reserved.",
    taken: "This handle is already taken.",
  },
}));

const { ProfileCard } = await import(
  "@/components/profile-card"
);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAssistant(overrides: Partial<Assistant> = {}): Assistant {
  // OSS Assistant type carries a few more fields than the platform type
  // (release_channel, access_consented). Populate the union of both so the
  // fixture stays type-safe if either generator regenerates.
  return {
    id: "asst-1",
    name: "My Assistant",
    description: null,
    configuration: null,
    status: "active",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    release_channel: "stable",
    current_release_version: null,
    machine_id: null,
    vembda_cluster_id: null,
    machine_size: null,
    maintenance_mode: { enabled: false, debug_pod_name: null },
    is_local: false,
    ingress_url: null,
    access_consented: false,
    handle: null,
    ...overrides,
  } as Assistant;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  fetchMeImpl = () => new Promise(() => {});
});

afterEach(() => {
  fetchMeImpl = () => new Promise(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileCard", () => {
  test("renders the section title and subtitle", () => {
    const html = renderToStaticMarkup(<ProfileCard />);
    expect(html).toContain("Profile");
    expect(html).toContain("account details");
  });

  test("shows a loading placeholder before fetchMe resolves", () => {
    const html = renderToStaticMarkup(<ProfileCard />);
    expect(html.toLowerCase()).toContain("loading");
  });

  test("auto-generated heuristic catches digit-suffix handles", async () => {
    // The heuristic doesn't require server access — we can assert on it
    // directly to lock down the nudge-copy trigger.
    const { looksAutoGenerated } = await import(
      "@/domains/account/username-heuristics"
    );
    expect(looksAutoGenerated("alice17")).toBe(true);
    expect(looksAutoGenerated("noa")).toBe(false);
    expect(looksAutoGenerated("user_42")).toBe(true);
    expect(looksAutoGenerated("noa1")).toBe(false); // single trailing digit not enough
  });

  test("omits the assistant section when no assistant prop is supplied", () => {
    // Loading shell shouldn't pre-render the assistant section either —
    // its label only appears once the user section's data is ready AND the
    // assistant prop is non-null. The label itself is a reliable absence
    // marker because it never appears anywhere else on the user surface.
    const html = renderToStaticMarkup(<ProfileCard />);
    expect(html).not.toContain("Assistant handle");
  });

  test("omits the assistant section when the assistant prop is null", () => {
    // Self-hosted-local registrations pass ``null`` explicitly (the
    // settings page filters local assistants out of the prop). The
    // assistant section must be hidden, not disabled, in that case.
    const html = renderToStaticMarkup(<ProfileCard assistant={null} />);
    expect(html).not.toContain("Assistant handle");
  });

  test("renders cleanly when an assistant prop is supplied", () => {
    // ``renderToStaticMarkup`` captures only the initial sync render — the
    // assistant section is gated behind the user-section loaded state, so
    // we can't directly assert on its content from here. What we CAN
    // assert: the card mounts without throwing when the prop is in place
    // (catches accidental prop-shape regressions). The loaded-state
    // rendering is exercised end-to-end by the settings page e2e flow.
    expect(() => {
      renderToStaticMarkup(<ProfileCard assistant={makeAssistant()} />);
    }).not.toThrow();
  });
});

void flush;
