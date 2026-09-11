import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { client } from "@/generated/daemon/client.gen";

mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: () => {},
}));
const { DesktopAppsPanel } = await import("./desktop-apps-panel");
const originalGet = client.get;
const originalPost = client.post;
let state = "available";
let missing = false;
let fail = false;
let posts: unknown[];
let queryClient: QueryClient;
beforeEach(() => {
  state = "available";
  missing = false;
  fail = false;
  posts = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.get = mock(async () => ({
    data: { apps: [{ id: "calculator", state }] },
    response: new Response(null, { status: missing ? 404 : 200 }),
  })) as unknown as typeof client.get;
  client.post = mock(async (options: { body: unknown }) => {
    posts.push(options.body);
    if (fail) {
      throw new Error("offline");
    }
    state = "installing";
    return {
      data: { apps: [{ id: "calculator", state }] },
      response: new Response(),
    };
  }) as unknown as typeof client.post;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  client.get = originalGet;
  client.post = originalPost;
});
function mount(connected = true) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DesktopAppsPanel assistantId="assistant-123" connected={connected} />
    </QueryClientProvider>,
  );
}
test("install progresses through background work to an explicit Open action", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Install" }));
  await screen.findByText("Installing…");
  expect(posts).toEqual([{ appId: "calculator", action: "add" }]);
  state = "added";
  await queryClient.invalidateQueries();
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(posts[1]).toEqual({ appId: "calculator", action: "open" }),
  );
});
test("already installed apps offer launcher creation and failures can retry", async () => {
  state = "installed";
  fail = true;
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add to desktop" }),
  );
  await screen.findByRole("alert");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Add to desktop" }));
  await screen.findByText("Installing…");
  expect(posts.length).toBe(2);
});
test("a disconnected desktop cannot launch and an older assistant exposes no write actions", async () => {
  state = "added";
  const mounted = mount(false);
  expect(
    (await screen.findByRole("button", { name: "Open" })).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  mounted.unmount();
  queryClient.clear();
  missing = true;
  mount();
  await screen.findByText("Update your assistant to add desktop apps.");
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  expect(posts).toEqual([]);
});
