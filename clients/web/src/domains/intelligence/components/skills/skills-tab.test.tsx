/**
 * Tests for the Skills tab's search ↔ URL (`?q=`) synchronization — the
 * two-way sync direction, not the list rendering:
 *
 * - typing debounces into `?q=` exactly once per settled value,
 * - an external `?q=` change WITHOUT a remount (re-clicking the Skills nav
 *   link to clear the query, back/forward, in-app filtered links) wins over
 *   the local input instead of being debounce-bounced back to the stale
 *   local value.
 *
 * The generated SDK is mocked with empty payloads (the queries only need to
 * settle); the tab is mounted with sibling probe/controls components on the
 * same route so URL changes never remount it. Mounted via
 * `@testing-library/react` (happy-dom — see `clients/web/test-setup.ts`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router";

import type {
  SkillsCategoriesGetResponse,
  SkillsGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

/** Mirrors `SEARCH_DEBOUNCE_MS` in `skills-tab.tsx` (not exported). */
const SEARCH_DEBOUNCE_MS = 300;

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  skillsGet: mock(async () => ({
    data: { skills: [] } as SkillsGetResponse,
    ...okResponse,
  })),
  skillsCategoriesGet: mock(async () => ({
    data: { categories: [] } as SkillsCategoriesGetResponse,
    ...okResponse,
  })),
}));

const { SkillsTab } =
  await import("@/domains/intelligence/components/skills/skills-tab");

/** Every distinct `location.search` the router passed through, in order. */
const searchLog: string[] = [];

function UrlProbe() {
  const location = useLocation();
  useEffect(() => {
    searchLog.push(location.search);
  }, [location.search]);
  return <div data-testid="url">{location.search}</div>;
}

/**
 * Simulates `?q=` changing from OUTSIDE the tab while it stays mounted —
 * the same route transition a nav-link re-click or an in-app filtered link
 * produces.
 */
function ExternalControls() {
  const [, setSearchParams] = useSearchParams();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setSearchParams(new URLSearchParams(), { replace: true })
        }
      >
        external-clear
      </button>
      <button
        type="button"
        onClick={() =>
          setSearchParams(new URLSearchParams([["q", "zeta"]]), {
            replace: true,
          })
        }
      >
        external-set
      </button>
    </>
  );
}

async function renderTab(initialSearch = ""): Promise<HTMLInputElement> {
  // Async act so the mocked queries' immediate resolutions flush in-act.
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/assistant/skills${initialSearch}`]}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false, gcTime: 0 } },
            })
          }
        >
          <Routes>
            <Route
              path="/assistant/skills"
              element={
                <>
                  <SkillsTab assistantId={ASSISTANT_ID} />
                  <UrlProbe />
                  <ExternalControls />
                </>
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  return screen.getByLabelText("Search skills") as HTMLInputElement;
}

/** Lets a full debounce window elapse so a wrong-direction write would land. */
async function settleDebounce() {
  await act(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, SEARCH_DEBOUNCE_MS + 150),
    );
  });
  // A debounced URL write re-keys the skills query as the act above exits;
  // the new fetch's resolution notifies subscribers through react-query's
  // `setTimeout(0)` — absorb that macrotask inside act as well.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** `fireEvent` here is raw DOM dispatch — act-wrap so updates flush in-act. */
function typeSearch(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

function clickButton(label: string) {
  act(() => {
    fireEvent.click(screen.getByText(label));
  });
}

beforeEach(() => {
  searchLog.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("SkillsTab search ↔ ?q= sync", () => {
  test("typing debounces into the URL exactly once", async () => {
    const input = await renderTab();

    typeSearch(input, "focus");

    // Local state updates immediately; the URL only after the debounce.
    expect(input.value).toBe("focus");
    expect(screen.getByTestId("url").textContent).toBe("");

    await settleDebounce();

    expect(screen.getByTestId("url").textContent).toBe("?q=focus");
    expect(searchLog.filter((s) => s.includes("q="))).toEqual(["?q=focus"]);
  });

  test("externally clearing ?q= resets the input instead of bouncing the URL", async () => {
    const input = await renderTab();

    typeSearch(input, "focus");
    await settleDebounce();
    expect(screen.getByTestId("url").textContent).toBe("?q=focus");

    // Nav-link re-click: same route, query string dropped, no remount. The
    // adoption effect runs within the click's act flush.
    clickButton("external-clear");
    expect(input.value).toBe("");

    // The stale debounced value must not resurrect `?q=focus`.
    await settleDebounce();
    expect(screen.getByTestId("url").textContent).toBe("");
    expect(input.value).toBe("");
  });

  test("an external ?q= value replaces the current input", async () => {
    const input = await renderTab("?q=alpha");
    expect(input.value).toBe("alpha");

    clickButton("external-set");
    expect(input.value).toBe("zeta");

    // The adopted value must stick — no bounce back to "alpha".
    await settleDebounce();
    expect(screen.getByTestId("url").textContent).toBe("?q=zeta");
    expect(input.value).toBe("zeta");
  });
});
