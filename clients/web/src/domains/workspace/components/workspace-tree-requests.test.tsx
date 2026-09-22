/**
 * The directory listings the workspace tree asks the assistant for. Against
 * an assistant with recursive listings, the workspace is fetched once and
 * search reaches every folder; against one without, opening a folder fetches
 * its contents and search filters open folders. Typing never fetches.
 *
 * Requests are counted at the daemon client's `fetch`, so the tree's own
 * query options and the SDK's request building run as they do in the app.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { WorkspaceTree } from "@/domains/workspace/components/workspace-tree";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";

const WORKSPACE_DEPTH = 4;

/** Whether the stubbed assistant understands `recursive=true`. */
let supportsRecursive = false;
let truncateRecursive = false;
/** Folders the stubbed recursive walk lists but does not enter. */
let skipRecursive = new Set<string>();

/** Two folders and one `theme-<depth>.md` file per directory, four levels deep. */
function listingFor(path: string) {
  const depth = path === "" ? 0 : path.split("/").length;
  const prefix = path === "" ? "" : `${path}/`;
  const entries = [];
  if (depth < WORKSPACE_DEPTH) {
    for (const name of ["d0", "d1"]) {
      entries.push({
        name,
        path: `${prefix}${name}`,
        type: "directory",
        size: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  entries.push({
    name: `theme-${depth}.md`,
    path: `${prefix}theme-${depth}.md`,
    type: "file",
    size: 10,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00.000Z",
  });
  return { path, entries };
}

/** The whole tree under `path`, depth-first, as the assistant lists it. */
function recursiveListingFor(path: string) {
  const entries: ReturnType<typeof listingFor>["entries"] = [];
  const skipped: string[] = [];
  const visit = (dir: string) => {
    const listing = listingFor(dir).entries;
    entries.push(...listing);
    for (const entry of listing) {
      if (entry.type !== "directory") {
        continue;
      }
      if (skipRecursive.has(entry.path)) {
        skipped.push(entry.path);
      } else {
        visit(entry.path);
      }
    }
  };
  visit(path);
  return { path, entries, truncated: truncateRecursive, skipped };
}

const realFetch = daemonClient.getConfig().fetch;
let requestedPaths: string[] = [];
const stubFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    if (!url.pathname.endsWith("/workspace/tree")) {
      return new Response(null, { status: 404 });
    }
    const path = url.searchParams.get("path") ?? "";
    const recursive = url.searchParams.get("recursive") === "true";
    requestedPaths.push(recursive ? `${path} (recursive)` : path);
    return Response.json(
      recursive && supportsRecursive
        ? recursiveListingFor(path)
        : listingFor(path),
    );
  },
  { preconnect: () => undefined },
);
daemonClient.setConfig({ fetch: stubFetch });

beforeEach(() => {
  requestedPaths = [];
  supportsRecursive = false;
  truncateRecursive = false;
  skipRecursive = new Set();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  daemonClient.setConfig({ fetch: realFetch });
});

interface TreeState {
  expandedPaths: Set<string>;
  search: string;
}

const ASSISTANT_ID = "assistant-1";

/** CI runs every test file in its own subprocess under load; give waits room. */
const WAIT = { timeout: 5_000 };
const TEST_TIMEOUT_MS = 20_000;

function renderTree(initial: TreeState) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  /** Resolves once a listing is in the cache, whether or not anything renders it. */
  const whenListed = (path: string, recursive = false) =>
    waitFor(() => {
      expect(
        queryClient.getQueryData(
          workspaceTreeQueryOptions({
            assistantId: ASSISTANT_ID,
            path,
            recursive,
          }).queryKey,
        ),
      ).toBeDefined();
    }, WAIT);
  const tree = ({ expandedPaths, search }: TreeState) => (
    <QueryClientProvider client={queryClient}>
      <WorkspaceTree
        assistantId={ASSISTANT_ID}
        expandedPaths={expandedPaths}
        selectedPath={null}
        showHidden={false}
        sortMode="name"
        onToggleExpand={() => {}}
        onExpandPath={() => {}}
        onSelectPath={() => {}}
        onToggleShowHidden={() => {}}
        onChangeSortMode={() => {}}
        onPathDeleted={() => {}}
        onPathRenamed={() => {}}
        search={search}
        onSearchChange={() => {}}
      />
    </QueryClientProvider>
  );
  const result = render(tree(initial));
  return {
    rerender: (next: TreeState) => result.rerender(tree(next)),
    whenListed,
  };
}

/** Past the search debounce, with room for any fetches it would start. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

function uniqueSorted(paths: string[]) {
  return [...new Set(paths)].sort();
}

describe("WorkspaceTree listing requests", () => {
  test(
    "typing a search requests nothing when no folder is open",
    async () => {
      const { rerender } = renderTree({ expandedPaths: new Set(), search: "" });
      await screen.findByText("d0");

      rerender({ expandedPaths: new Set(), search: "theme" });
      await settle();

      expect(uniqueSorted(requestedPaths)).toEqual(["", " (recursive)"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a search reads only the folders that are open",
    async () => {
      const expandedPaths = new Set(["d0"]);
      const { rerender } = renderTree({ expandedPaths, search: "" });
      await screen.findByText("theme-1.md");

      rerender({ expandedPaths, search: "theme" });
      await settle();

      expect(uniqueSorted(requestedPaths)).toEqual(["", " (recursive)", "d0"]);
      expect(screen.getByText("theme-0.md")).toBeTruthy();
      // d1 holds a theme-1.md too, but d1 is closed.
      expect(screen.getAllByText("theme-1.md")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "opening a folder requests that folder alone",
    async () => {
      const { rerender } = renderTree({ expandedPaths: new Set(), search: "" });
      await screen.findByText("d1");

      rerender({ expandedPaths: new Set(["d1"]), search: "" });
      await screen.findByText("theme-1.md");
      await settle();

      expect(uniqueSorted(requestedPaths)).toEqual(["", " (recursive)", "d1"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a search with no match in open folders says so",
    async () => {
      const { rerender } = renderTree({ expandedPaths: new Set(), search: "" });
      await screen.findByText("d0");

      rerender({ expandedPaths: new Set(), search: "nothing-matches" });

      await waitFor(() => {
        expect(screen.getByText("No matches in open folders")).toBeTruthy();
      }, WAIT);
      expect(screen.getByText("Searching open folders")).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  test("folder rows report whether they are open; file rows do not", async () => {
    renderTree({ expandedPaths: new Set(["d0"]), search: "" });
    await screen.findByText("theme-1.md");

    // The open root d0 lists first, then the closed d0 inside it.
    const [openFolder, nestedFolder] = screen.getAllByRole("button", {
      name: "d0",
    });
    expect(openFolder.getAttribute("aria-expanded")).toBe("true");
    expect(nestedFolder.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: /theme-0\.md/ })
        .hasAttribute("aria-expanded"),
    ).toBe(false);
  });
});

describe("WorkspaceTree against an assistant with recursive listings", () => {
  beforeEach(() => {
    supportsRecursive = true;
  }, TEST_TIMEOUT_MS);

  test(
    "a search finds a file in a closed folder with no extra request",
    async () => {
      const { rerender, whenListed } = renderTree({
        expandedPaths: new Set(),
        search: "",
      });
      await whenListed("", true);

      rerender({ expandedPaths: new Set(), search: "theme-3" });
      await waitFor(() => {
        expect(screen.getAllByText("theme-3.md").length).toBeGreaterThan(0);
      }, WAIT);
      await settle();

      expect(uniqueSorted(requestedPaths)).toEqual(["", " (recursive)"]);
      // The folders holding the matches show as open, so the matches are visible.
      expect(
        screen
          .getAllByRole("button", { name: "d0" })[0]
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(screen.queryByText("Searching open folders")).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "opening a folder shows its contents at once and refreshes them with one request",
    async () => {
      const { rerender, whenListed } = renderTree({
        expandedPaths: new Set(),
        search: "",
      });
      await whenListed("", true);

      rerender({ expandedPaths: new Set(["d1"]), search: "" });
      // Synchronously: the recursive listing already holds d1's contents.
      expect(screen.getByText("theme-1.md")).toBeTruthy();
      await whenListed("d1");

      expect(uniqueSorted(requestedPaths)).toEqual(["", " (recursive)", "d1"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a folder the walk did not enter makes the search say so until it is opened",
    async () => {
      skipRecursive = new Set(["d1"]);
      const { rerender, whenListed } = renderTree({
        expandedPaths: new Set(),
        search: "",
      });
      await whenListed("", true);

      rerender({ expandedPaths: new Set(), search: "theme" });
      await waitFor(() => {
        expect(
          screen.getByText(
            "Some folders are not searched. Open a folder to search inside it.",
          ),
        ).toBeTruthy();
      }, WAIT);

      rerender({ expandedPaths: new Set(["d1"]), search: "theme" });
      await whenListed("d1");
      await waitFor(() => {
        expect(
          screen.queryByText(
            "Some folders are not searched. Open a folder to search inside it.",
          ),
        ).toBeNull();
      }, WAIT);
      expect(screen.getAllByText("theme-1.md").length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a search with no match anywhere says so, with no scope note",
    async () => {
      const { rerender, whenListed } = renderTree({
        expandedPaths: new Set(),
        search: "",
      });
      await whenListed("", true);

      rerender({ expandedPaths: new Set(), search: "nothing-matches" });
      await waitFor(() => {
        expect(screen.getByText("No matches")).toBeTruthy();
      }, WAIT);
      expect(screen.queryByText("Searching open folders")).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a truncated workspace listing says the search is incomplete",
    async () => {
      truncateRecursive = true;
      const { rerender, whenListed } = renderTree({
        expandedPaths: new Set(),
        search: "",
      });
      await whenListed("", true);

      rerender({ expandedPaths: new Set(), search: "theme" });
      await waitFor(() => {
        expect(
          screen.getByText(
            "Some folders are not searched. Open a folder to search inside it.",
          ),
        ).toBeTruthy();
      }, WAIT);
    },
    TEST_TIMEOUT_MS,
  );
});
