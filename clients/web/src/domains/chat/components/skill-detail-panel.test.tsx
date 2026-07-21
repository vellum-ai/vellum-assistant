/**
 * Tests for the chat `SkillDetailPanel`'s skill-query branching — the
 * stale-while-revalidate error gate, not the detail rendering:
 *
 * - a failed revalidation of a CACHED skill degrades to the cached render
 *   (TanStack v5 keeps `data` when a refetch fails, so `isError` alone must
 *   not replace a usable detail view with the error state),
 * - an error with no cached skill shows the panel's error state,
 * - the happy path renders the fetched skill.
 *
 * The generated SDK's `skillsByIdGet` is mocked with a per-test failure knob
 * and the test client mirrors the production `staleTime` — both following
 * `skill-detail-page.test.tsx`, which covers the same gate on the dedicated
 * page. The files-list query resolves empty so the SKILL.md chain stays out
 * of the way. Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type {
  SkillsByIdFilesGetResponse,
  SkillsByIdGetResponse,
} from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-1";
const SKILL_ID = "skill-1";
const SKILL_DESCRIPTION = "A skill used in panel tests";
const ERROR_COPY = "This skill could not be loaded. It may have been removed.";
const okResponse = { response: new Response(), error: undefined };

/**
 * Mirrors the app QueryClient's `staleTime` (`components/providers.tsx`) so
 * the suite exercises production mount-refetch semantics — the revalidation
 * cases below must backdate their seeded cache entries past this window for
 * a mount to kick off the background refetch under test.
 */
const PRODUCTION_STALE_TIME_MS = 10_000;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: PRODUCTION_STALE_TIME_MS },
    },
  });
}

// Per-test holder: each `skillsByIdGet` call resolves with the current
// payload, rejecting with `skillError` when set (lets a case fail the fetch).
let skillPayload: SkillsByIdGetResponse["skill"];
let skillError: Error | null = null;

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  skillsByIdGet: mock(async () => {
    if (skillError) {
      throw skillError;
    }
    return {
      data: { skill: skillPayload } as SkillsByIdGetResponse,
      ...okResponse,
    };
  }),
  // No SKILL.md entry: the content query stays disabled and the panel body
  // reduces to the skill description this suite asserts on.
  skillsByIdFilesGet: mock(async () => ({
    data: { files: [] } as unknown as SkillsByIdFilesGetResponse,
    ...okResponse,
  })),
}));

const { SkillDetailPanel } =
  await import("@/domains/chat/components/skill-detail-panel");
const { skillsByIdGetOptions } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

function makeSkillDetail(): SkillsByIdGetResponse["skill"] {
  return {
    id: SKILL_ID,
    name: "Fresh Skill",
    description: SKILL_DESCRIPTION,
    kind: "installed",
    status: "enabled",
    category: "general",
    origin: "custom",
  };
}

/** The exact single-skill query key the panel resolves from. */
function skillQueryKey() {
  return skillsByIdGetOptions({
    path: { assistant_id: ASSISTANT_ID, id: SKILL_ID },
  }).queryKey;
}

function renderPanel(client: QueryClient = makeQueryClient()): QueryClient {
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SkillDetailPanel skillId={SKILL_ID} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}

beforeEach(() => {
  skillPayload = makeSkillDetail();
  skillError = null;
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("SkillDetailPanel skill query states", () => {
  test("renders the fetched skill detail", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(SKILL_DESCRIPTION)).toBeTruthy();
    });
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
  });

  test("keeps the cached skill rendered when a revalidation fails", async () => {
    // In TanStack v5 a failed refetch sets `isError` while KEEPING the cached
    // data — a brief daemon blip must not replace an already-rendered skill
    // with the error state.
    skillError = new Error("daemon unavailable");

    const client = makeQueryClient();
    client.setQueryData(
      skillQueryKey(),
      { skill: makeSkillDetail() } as SkillsByIdGetResponse,
      // Backdate the entry past `staleTime` so the mount kicks off a
      // background revalidation (the panel, unlike the detail page, doesn't
      // force one with `refetchOnMount: "always"`).
      { updatedAt: Date.now() - (PRODUCTION_STALE_TIME_MS + 1_000) },
    );

    renderPanel(client);

    // The revalidation settles into an error...
    await waitFor(() => {
      expect(client.getQueryState(skillQueryKey())?.status).toBe("error");
    });

    // ...and the cached detail keeps rendering instead of the error state.
    await waitFor(() => {
      expect(screen.getByText(SKILL_DESCRIPTION)).toBeTruthy();
    });
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
  });

  test("shows the error state when the fetch fails with no cached skill", async () => {
    skillError = new Error("daemon unavailable");

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(ERROR_COPY)).toBeTruthy();
    });
    expect(screen.queryByText(SKILL_DESCRIPTION)).toBeNull();
  });
});
