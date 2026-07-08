/**
 * Tests for the skill detail route (`/assistant/skills/:skillId`) — the
 * page-level branching, not the detail rendering:
 *
 * - the not-found guard waits for an in-flight list refetch before declaring
 *   a skill missing (a fresh skill can be absent from a cached list),
 * - the page forces that refetch itself even when the cached list is still
 *   fresh under the app QueryClient's `staleTime` (the test client mirrors
 *   the production value so this can't silently regress),
 * - a failed mount revalidation degrades to the cached render — the
 *   full-page error state is reserved for a failure with no cached list,
 * - the back button restores the Skills list's query string passed as
 *   router state (search/filter/category survive detail navigation).
 *
 * The generated SDK's `skillsGet` is mocked with a per-test deferred so a
 * case can hold the list refetch pending; the heavy `SkillDetail` /
 * `SkillDetailMobile` views are stubbed with light stand-ins exposing the
 * `onBack` wiring. Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
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
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { SkillInfo } from "@/domains/intelligence/skills/types";
import type { SkillsGetResponse } from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

/**
 * Mirrors the app QueryClient's `staleTime` (`components/providers.tsx`) so
 * the suite exercises production mount-refetch semantics: a <10s-old cached
 * list is fresh and would NOT refetch on mount by default — the page must
 * force revalidation itself (`refetchOnMount: "always"`) for the not-found
 * guard to ever see a refetch.
 */
const PRODUCTION_STALE_TIME_MS = 10_000;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: PRODUCTION_STALE_TIME_MS },
    },
  });
}

// Per-test holder: each `skillsGet` call resolves with the current payload,
// gated on `listGate` when set (lets a case hold a refetch in flight) and
// rejecting with `listError` when set (lets a case fail the fetch).
let listSkills: SkillInfo[];
let listGate: Promise<unknown> | null = null;
let listError: Error | null = null;

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  skillsGet: mock(async () => {
    if (listGate) {
      await listGate;
    }
    if (listError) {
      throw listError;
    }
    return {
      data: { skills: listSkills } as SkillsGetResponse,
      ...okResponse,
    };
  }),
}));

// Stub the heavy detail views — this suite targets the page's branching, not
// the file browser. The stand-ins expose the `onBack` wiring under test.
mock.module("@/domains/intelligence/components/skills/skill-detail", () => ({
  SkillDetail: ({
    skill,
    onBack,
  }: {
    skill: SkillInfo;
    onBack: () => void;
  }) => (
    <div>
      <span>Detail: {skill.name}</span>
      <button type="button" onClick={onBack}>
        Back to skills
      </button>
    </div>
  ),
}));
mock.module(
  "@/domains/intelligence/components/skills/skill-detail-mobile",
  () => ({
    SkillDetailMobile: () => <div>Mobile detail</div>,
  }),
);

const { SkillDetailPage } = await import(
  "@/domains/intelligence/skill-detail-page"
);
const { skillsGetOptions } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "skill-1",
    name: "Fresh Skill",
    description: "A skill used in detail page tests",
    kind: "installed",
    status: "enabled",
    origin: "custom",
    category: "general",
    ...overrides,
  };
}

/** The exact list query key the page (and the Skills tab) resolves from. */
function listQueryKey() {
  return skillsGetOptions({
    path: { assistant_id: ASSISTANT_ID },
    query: { include: "catalog" },
  }).queryKey;
}

// Sentinel at the list route so tests can prove which query string the back
// navigation landed on.
function SkillsListLanding() {
  const location = useLocation();
  return <div>Skills list at: [{location.search}]</div>;
}

function renderDetail({
  skillId,
  listSearch,
  client = makeQueryClient(),
}: {
  skillId: string;
  listSearch?: string;
  client?: QueryClient;
}): void {
  const entry = {
    pathname: `/assistant/skills/${skillId}`,
    state: listSearch === undefined ? null : { listSearch },
  };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route
            path="/assistant/skills/:skillId"
            element={<SkillDetailPage />}
          />
          <Route path="/assistant/skills" element={<SkillsListLanding />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listSkills = [makeSkill()];
  listGate = null;
  listError = null;
});

afterEach(() => {
  cleanup();
});

describe("SkillDetailPage stale-list guard", () => {
  test("shows loading (not 'Skill not found') while an outdated cached list refetches", async () => {
    // Seed a cached list that predates the requested skill; hold the
    // mount-triggered background refetch in flight.
    let releaseGate!: (value?: unknown) => void;
    listGate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    listSkills = [makeSkill()];

    const client = makeQueryClient();
    client.setQueryData(listQueryKey(), {
      skills: [makeSkill({ id: "older-skill", name: "Older Skill" })],
    } as SkillsGetResponse);

    renderDetail({ skillId: "skill-1", client });

    // Cached data without the skill + refetch in flight: loading, no verdict.
    expect(screen.queryByText("Skill not found")).toBeNull();
    expect(document.querySelector(".animate-spin")).not.toBeNull();

    releaseGate();

    // The refetch lands with the fresh skill and the detail renders.
    await waitFor(() => {
      expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();
    });
    expect(screen.queryByText("Skill not found")).toBeNull();
  });

  test("resolves a skill missing from a FRESH cached list (mount revalidation defeats staleTime)", async () => {
    // Production repro: the Skills tab was viewed seconds ago (cache fresh
    // under the 10s staleTime), then a freshly-authored skill's in-chat card
    // is clicked. `setQueryData` stamps the entry as just-updated, so the
    // default mount behavior would skip the refetch entirely and the page
    // would render a terminal "Skill not found".
    listSkills = [makeSkill()];

    const client = makeQueryClient();
    client.setQueryData(listQueryKey(), {
      skills: [makeSkill({ id: "older-skill", name: "Older Skill" })],
    } as SkillsGetResponse);

    renderDetail({ skillId: "skill-1", client });

    // The page forces a revalidation and the fresh skill resolves.
    await waitFor(() => {
      expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();
    });
    expect(screen.queryByText("Skill not found")).toBeNull();
  });

  test("declares not-found once the list has settled without the skill", async () => {
    listSkills = [];

    renderDetail({ skillId: "missing-skill" });

    await waitFor(() => {
      expect(screen.getByText("Skill not found")).toBeTruthy();
    });
  });
});

describe("SkillDetailPage revalidation failure", () => {
  test("keeps the cached detail rendered when the mount revalidation fails", async () => {
    // Every mount revalidates (`refetchOnMount: "always"`), and in TanStack
    // v5 a failed refetch sets `isError` while KEEPING the cached data — a
    // brief daemon blip must not replace an already-rendered detail with the
    // full-page error state.
    listError = new Error("daemon unavailable");

    const client = makeQueryClient();
    client.setQueryData(listQueryKey(), {
      skills: [makeSkill()],
    } as SkillsGetResponse);

    renderDetail({ skillId: "skill-1", client });

    // The cached detail renders immediately...
    expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();

    // ...and survives the refetch settling into an error.
    await waitFor(() => {
      expect(client.getQueryState(listQueryKey())?.status).toBe("error");
    });
    expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();
    expect(screen.queryByText("Failed to load skills")).toBeNull();
  });

  test("shows the error state when the list fails with no cached data", async () => {
    listError = new Error("daemon unavailable");

    renderDetail({ skillId: "skill-1" });

    await waitFor(() => {
      expect(screen.getByText("Failed to load skills")).toBeTruthy();
    });
    expect(screen.queryByText("Detail: Fresh Skill")).toBeNull();
  });
});

describe("SkillDetailPage back navigation", () => {
  test("back restores the list query string passed as router state", async () => {
    renderDetail({
      skillId: "skill-1",
      listSearch: "?filter=installed&category=email",
    });

    await waitFor(() => {
      expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Back to skills"));

    await waitFor(() => {
      expect(
        screen.getByText("Skills list at: [?filter=installed&category=email]"),
      ).toBeTruthy();
    });
  });

  test("back falls back to the plain list without router state", async () => {
    renderDetail({ skillId: "skill-1" });

    await waitFor(() => {
      expect(screen.getByText("Detail: Fresh Skill")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Back to skills"));

    await waitFor(() => {
      expect(screen.getByText("Skills list at: []")).toBeTruthy();
    });
  });
});
