import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { client } from "@/generated/daemon/client.gen";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppsGetResponse } from "@/generated/daemon/types.gen";
import type * as UsePinnedApps from "@/hooks/use-pinned-apps";
import { clearAppHtmlCache } from "@/utils/app-html-cache";

mock.module(
  "@/hooks/use-pinned-apps",
  (): Partial<typeof UsePinnedApps> => ({
    usePinnedApps: () => ({
      pinnedApps: [],
      pinnedAppIds: new Set<string>(),
      source: "daemon",
      togglePin: () => {},
      unpin: () => {},
      setColor: () => {},
    }),
  }),
);

const { AppReopenCard } = await import("./app-reopen-card");

const ASSISTANT_ID = "assistant-123";
const APP_ID = "app-123";
const QUERY_KEY = appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } });
const FINISHED = "<html><body><h1>Expense tracker</h1></body></html>";
const post = spyOn(client, "post");
const originalObserver = globalThis.IntersectionObserver;

class VisibleObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect(): void {}
}

globalThis.IntersectionObserver =
  VisibleObserver as unknown as typeof IntersectionObserver;

afterAll(() => {
  globalThis.IntersectionObserver = originalObserver;
  post.mockRestore();
});

afterEach(() => {
  cleanup();
  clearAppHtmlCache(ASSISTANT_ID, APP_ID);
  post.mockReset();
});

function seedApp(queryClient: QueryClient, updatedAt: number): void {
  queryClient.setQueryData<AppsGetResponse>(QUERY_KEY, {
    apps: [
      {
        id: APP_ID,
        name: "Expense tracker",
        createdAt: 1,
        updatedAt,
        version: "1",
        contentId: "content-123",
        origin: "workspace",
      },
    ],
  });
}

function renderCard(html: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedApp(queryClient, 1);
  post.mockResolvedValue({ data: { html } } as never);
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <AppReopenCard
        appId={APP_ID}
        assistantId={ASSISTANT_ID}
        onOpenApp={() => {}}
      />
    </QueryClientProvider>,
  );
  return { queryClient, container };
}

describe("new app thumbnails", () => {
  test("shows rich HTML when the first build is complete", async () => {
    const { container } = renderCard(FINISHED);
    await waitFor(() => {
      expect(container.querySelector("iframe")?.srcdoc).toContain(
        "<h1>Expense tracker</h1>",
      );
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("replaces a scaffold thumbnail when the finished app summary arrives", async () => {
    const { container, queryClient } = renderCard("<p>Loading...</p>");
    await waitFor(() => {
      expect(container.querySelector("iframe")?.srcdoc).toContain("Loading...");
    });
    post.mockResolvedValue({ data: { html: FINISHED } } as never);
    act(() => seedApp(queryClient, 2));
    await waitFor(() => {
      expect(container.querySelector("iframe")?.srcdoc).toContain(
        "<h1>Expense tracker</h1>",
      );
    });
    expect(container.querySelector("iframe")?.srcdoc).not.toContain(
      "Loading...",
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("removes a prior thumbnail when the next revision fails to load", async () => {
    const { container, queryClient } = renderCard("<p>Loading...</p>");
    await waitFor(() => {
      expect(container.querySelector("iframe")?.srcdoc).toContain("Loading...");
    });
    post.mockResolvedValue({ data: { html: { html: FINISHED } } } as never);
    act(() => seedApp(queryClient, 2));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
    expect(container.innerHTML).not.toContain("[object Object]");
  });

  test("keeps the fallback for an object response and shows the next completed build", async () => {
    const { container, queryClient } = renderCard({ html: FINISHED });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.innerHTML).not.toContain("[object Object]");
    post.mockResolvedValue({ data: { html: FINISHED } } as never);
    act(() => seedApp(queryClient, 2));
    await waitFor(() => {
      expect(container.querySelector("iframe")?.srcdoc).toContain(
        "<h1>Expense tracker</h1>",
      );
    });
  });
});
