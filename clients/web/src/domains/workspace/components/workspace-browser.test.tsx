import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import type { WorkspaceFileGetResponse } from "@/generated/daemon/types.gen";
import type * as SideListRoom from "@/hooks/use-side-list-room";
import { pressBackdrop } from "@/lib/overlay-test-helpers";
import * as nativeFile from "@/runtime/native-file";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

import {
  seedWorkspaceStory,
  WORKSPACE_STORY_ASSISTANT_ID,
  WORKSPACE_STORY_FILES,
  WORKSPACE_STORY_TREE,
} from "../workspace-story-fixtures";
import { workspaceFileRetrieveOptions } from "../utils/workspace-file-query";

let hasRoomForList = false;
const { useSideListRoom: actualUseSideListRoom } =
  await import("@/hooks/use-side-list-room");
mock.module(
  "@/hooks/use-side-list-room",
  (): Partial<typeof SideListRoom> => ({
    useSideListRoom: () => ({ ...actualUseSideListRoom(), hasRoomForList }),
  }),
);
const { WorkspaceBrowser } = await import("./workspace-browser");

function fileQueryKey(path: string) {
  return workspaceFileRetrieveOptions({
    path: { assistant_id: WORKSPACE_STORY_ASSISTANT_ID },
    query: { path, showHidden: false },
  }).queryKey;
}

function renderBrowser(
  file?: string,
  configure?: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedWorkspaceStory(client);
  configure?.(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          `/assistant/workspace${file ? `?file=${encodeURIComponent(file)}` : ""}`,
        ]}
      >
        <WorkspaceBrowser assistantId={WORKSPACE_STORY_ASSISTANT_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPicker(path?: string) {
  const name = path ? `Switch file: ${path}` : "Choose a file";
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name: "Files" });
}

beforeEach(() => {
  hasRoomForList = false;
});
afterEach(() => {
  cleanup();
  mock.restore();
});

describe("Workspace file switching", () => {
  test("the empty card's switcher opens an accessible sheet without focusing search", async () => {
    renderBrowser();
    expect(screen.getByText("Nothing open yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse files" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Choose a file" });
    expect(
      trigger.closest('[data-slot="workspace-file-header"]'),
    ).not.toBeNull();
    expect(screen.queryByText(/Tap Choose a file above/)).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    const dialog = await openPicker();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(dialog).getByRole("textbox", { name: "Search files" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Sort by size" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Create new file or folder" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Show hidden files" }),
    ).toBeTruthy();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(0);
  });

  test("search finds files in closed folders, selection clears it and resets the view mode", async () => {
    renderBrowser();
    let dialog = await openPicker();
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "PROJECT-PLAN" },
    });
    const nestedFile = await within(dialog).findByRole("button", {
      name: /project-plan-with/,
    });
    expect(
      within(dialog)
        .getByRole("button", { name: "notes" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(dialog).queryByRole("button", { name: /README/ })).toBeNull();
    fireEvent.click(nestedFile);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Project plan" })).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Formatted" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    dialog = await openPicker(
      WORKSPACE_STORY_FILES.find(({ name }) =>
        name.startsWith("project-plan-with"),
      )!.path,
    );
    expect(
      (within(dialog).getByRole("textbox") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /config.json/ }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen
        .getByRole("radio", { name: "Source" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Formatted" }));
    dialog = await openPicker("config.json");
    fireEvent.click(within(dialog).getByRole("button", { name: /README.md/ }));
    await screen.findByRole("heading", { name: "Your workspace" });
    expect(
      screen
        .getByRole("radio", { name: "Formatted" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("folder expansion survives dismissal and the current file remains highlighted", async () => {
    renderBrowser("README.md");
    let dialog = await openPicker("README.md");
    fireEvent.click(within(dialog).getByRole("button", { name: "notes" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "projects" }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "example" }),
    );
    expect(
      await within(dialog).findByRole("button", { name: /project-plan-with/ }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("button", { name: /README.md/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    pressBackdrop(
      document.querySelector('[data-slot="bottom-sheet-overlay"]')!,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openPicker("README.md");
    expect(
      within(dialog)
        .getByRole("button", { name: "notes" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close file list" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a short drag stays open; dragging the handle down dismisses", async () => {
    renderBrowser();
    const dialog = await openPicker();
    const handle = within(dialog).getByRole("button", {
      name: "Close file list",
    });
    handle.setPointerCapture = () => undefined;
    handle.hasPointerCapture = () => false;
    const pointer = {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    };
    const drag = (distance: number) => {
      fireEvent.pointerDown(handle, { ...pointer, clientY: 100 });
      fireEvent.pointerMove(handle, { ...pointer, clientY: 100 + distance });
      fireEvent.pointerUp(handle, { ...pointer, clientY: 100 + distance });
    };
    drag(30);
    expect(screen.getByRole("dialog")).toBeTruthy();
    drag(140);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("the sheet can show, open, and hide hidden files", async () => {
    renderBrowser();
    let dialog = await openPicker();
    expect(
      within(dialog).queryByRole("button", { name: /\.notes.md/ }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show hidden files" }),
    );
    const hiddenFile = await within(dialog).findByRole("button", {
      name: /\.notes.md/,
    });
    fireEvent.click(hiddenFile);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await screen.findByRole("heading", { name: "Hidden notes" }),
    ).toBeTruthy();

    dialog = await openPicker(".notes.md");
    expect(
      within(dialog)
        .getByRole("button", { name: "Hide hidden files" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: /README.md/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openPicker("README.md");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide hidden files" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: /\.notes.md/ }),
      ).toBeNull(),
    );
    expect(
      within(dialog).getByRole("button", { name: /README.md/ }),
    ).toBeTruthy();
  });

  test("a hidden-file deep link can be revealed from the sheet", async () => {
    const originalFetch = daemonClient.getConfig().fetch;
    daemonClient.setConfig({
      fetch: Object.assign(
        async () => Response.json({ error: "File not found" }, { status: 404 }),
        { preconnect: () => undefined },
      ),
    });
    try {
      renderBrowser(".notes.md");
      expect(await screen.findByText("File not found")).toBeTruthy();
      const dialog = await openPicker(".notes.md");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Show hidden files" }),
      );
      fireEvent.click(
        await within(dialog).findByRole("button", { name: /\.notes.md/ }),
      );
      expect(
        await screen.findByRole("heading", { name: "Hidden notes" }),
      ).toBeTruthy();
    } finally {
      daemonClient.setConfig({ fetch: originalFetch });
    }
  });

  test.each(["loaded", "missing"] as const)(
    "selection keeps the same switcher through pending and %s content",
    async (outcome) => {
      const file = WORKSPACE_STORY_FILES.find(
        ({ path }) => path === "README.md",
      )!;
      let resolveFile!: (file: WorkspaceFileGetResponse) => void;
      let rejectFile!: (error: Error) => void;
      const pendingFile = new Promise<WorkspaceFileGetResponse>(
        (resolve, reject) => {
          resolveFile = resolve;
          rejectFile = reject;
        },
      );
      const get = spyOn(daemonClient, "get").mockImplementation((async () => ({
        data: await pendingFile,
      })) as typeof daemonClient.get);
      renderBrowser(undefined, (client) => {
        client.removeQueries({
          queryKey: fileQueryKey(file.path),
          exact: true,
        });
      });
      const trigger = screen.getByRole("button", { name: "Choose a file" });
      const dialog = await openPicker();
      fireEvent.click(
        within(dialog).getByRole("button", { name: /README.md/ }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/v1/assistants/{assistant_id}/workspace/file",
          path: { assistant_id: WORKSPACE_STORY_ASSISTANT_ID },
          query: { path: file.path },
        }),
      );
      expect(
        screen.getByRole("button", { name: `Switch file: ${file.path}` }),
      ).toBe(trigger);
      expect(screen.queryByRole("radio")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(trigger));

      if (outcome === "loaded") {
        resolveFile(file);
        expect(
          await screen.findByRole("heading", { name: "Your workspace" }),
        ).toBeTruthy();
        expect(
          screen
            .getByRole("radio", { name: "Formatted" })
            .getAttribute("aria-checked"),
        ).toBe("true");
      } else {
        rejectFile(new Error("File not found"));
        expect(await screen.findByText("File not found")).toBeTruthy();
        expect(screen.queryByRole("radio")).toBeNull();
      }
      expect(
        screen.getByRole("button", { name: `Switch file: ${file.path}` }),
      ).toBe(trigger);

      const reopened = await openPicker(file.path);
      fireEvent.click(
        within(reopened).getByRole("button", { name: /config.json/ }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        screen.getByRole("button", { name: "Switch file: config.json" }),
      ).toBe(trigger);
      expect(
        screen
          .getByRole("radio", { name: "Source" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    },
  );

  test.each([
    { path: "README.md", label: "README.md" },
    { path: "tools/workspace-ask.sh", label: "tools/workspace-ask.sh" },
    {
      path: "projects/计划/发布/🚀-implementation-notes-with-a-long-filename.md",
      label: "…/发布/🚀-implementation-notes-with-a-long-filename.md",
    },
  ])("displays $label while exposing the complete path", ({ path, label }) => {
    renderBrowser(path, (client) => {
      client.setQueryData(fileQueryKey(path), {
        path,
        name: path.split("/").at(-1)!,
        size: 32,
        mimeType: "text/plain",
        modifiedAt: "2026-01-01T00:00:00Z",
        isBinary: false,
        content: "Example file contents",
      } satisfies WorkspaceFileGetResponse);
    });
    const trigger = screen.getByRole("button", {
      name: `Switch file: ${path}`,
    });
    expect(trigger.textContent).toBe(label);
    expect(trigger.getAttribute("title")).toBe(path);
    const hint = document.getElementById(
      trigger.getAttribute("aria-describedby")!,
    );
    expect(hint?.textContent).toBe("Opens file list");
    expect(
      document.querySelectorAll('[data-slot="workspace-file-header"]'),
    ).toHaveLength(1);
  });

  test("plain text retains editing, copy and download without unsupported view modes", async () => {
    const path = "example.txt";
    renderBrowser(path, (client) => {
      client.setQueryData(fileQueryKey(path), {
        path,
        name: path,
        size: 32,
        mimeType: "text/plain",
        modifiedAt: "2026-01-01T00:00:00Z",
        isBinary: false,
        content: "Original text",
      } satisfies WorkspaceFileGetResponse);
    });
    const trigger = screen.getByRole("button", {
      name: `Switch file: ${path}`,
    });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy file contents" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Draft text" },
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Original text")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Switch file: ${path}` }),
    ).toBe(trigger);
    const dialog = await openPicker(path);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("changing Markdown mode discards a draft, and source edits still save", async () => {
    const file = WORKSPACE_STORY_FILES.find(
      ({ path }) => path === "README.md",
    )!;
    const updatedFile = { ...file, content: "# Saved workspace" };
    const post = spyOn(daemonClient, "post").mockImplementation((async () => ({
      data: {},
      response: new Response(null, { status: 200 }),
    })) as typeof daemonClient.post);
    spyOn(daemonClient, "get").mockImplementation((async () => ({
      data: updatedFile,
    })) as typeof daemonClient.get);
    renderBrowser(file.path);
    const trigger = screen.getByRole("button", {
      name: `Switch file: ${file.path}`,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# Discarded draft" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Formatted" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Your workspace" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Discarded draft" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      file.content,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: updatedFile.content },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/v1/assistants/{assistant_id}/workspace/write",
          path: { assistant_id: WORKSPACE_STORY_ASSISTANT_ID },
          body: {
            path: file.path,
            content: updatedFile.content,
            encoding: "utf8",
          },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    fireEvent.click(screen.getByRole("radio", { name: "Formatted" }));
    expect(
      await screen.findByRole("heading", { name: "Saved workspace" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Switch file: ${file.path}` }),
    ).toBe(trigger);
  });

  test.each([
    { path: "example.png", mimeType: "image/png" },
    { path: "example.mp4", mimeType: "video/mp4" },
    { path: "example.zip", mimeType: "application/zip" },
  ])(
    "$mimeType has one switcher and a working download",
    async ({ path, mimeType }) => {
      const blob = new Blob(["Example content"], { type: mimeType });
      const save = spyOn(nativeFile, "saveFile").mockResolvedValue(undefined);
      const get = spyOn(daemonClient, "get").mockImplementation((async (
        options: { url: string },
      ) => ({
        data: options.url.endsWith("/content")
          ? blob
          : {
              path,
              name: path,
              mimeType,
              size: 2048,
              modifiedAt: "2026-01-01T00:00:00Z",
              isBinary: true,
              content: null,
            },
      })) as typeof daemonClient.get);
      renderBrowser(path);
      const trigger = screen.getByRole("button", {
        name: `Switch file: ${path}`,
      });
      const download = await screen.findByRole("button", {
        name: `Download ${path}`,
      });
      expect(
        document.querySelectorAll('[data-slot="workspace-file-header"]'),
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("button", { name: `Switch file: ${path}` }),
      ).toHaveLength(1);
      expect(screen.queryByRole("radio")).toBeNull();
      if (mimeType.startsWith("image/")) {
        expect(await screen.findByRole("img", { name: path })).toBeTruthy();
      } else if (mimeType.startsWith("video/")) {
        await waitFor(() =>
          expect(document.querySelector("video[controls]")).not.toBeNull(),
        );
      } else {
        expect(screen.getByText(mimeType)).toBeTruthy();
      }
      fireEvent.click(download);
      await waitFor(() => expect(save).toHaveBeenCalledWith(blob, path));
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/v1/assistants/{assistant_id}/workspace/file/content",
          path: { assistant_id: WORKSPACE_STORY_ASSISTANT_ID },
          query: { path },
        }),
      );
      const dialog = await openPicker(path);
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    },
  );

  test("deleting the selected file returns the same switcher to the empty state", async () => {
    const deletedPath = "README.md";
    const post = spyOn(daemonClient, "post").mockImplementation((async () => ({
      data: {},
      response: new Response(null, { status: 200 }),
    })) as typeof daemonClient.post);
    spyOn(daemonClient, "get").mockImplementation((async (options: {
      url: string;
      query?: { recursive?: string };
    }) => {
      if (options.url.endsWith("/tree")) {
        return {
          data: {
            ...WORKSPACE_STORY_TREE,
            entries: WORKSPACE_STORY_TREE.entries.filter(
              ({ path }) =>
                path !== deletedPath &&
                !path.startsWith(".") &&
                (options.query?.recursive === "true" || !path.includes("/")),
            ),
          },
        };
      }
      return { error: { error: "File not found" } };
    }) as typeof daemonClient.get);
    renderBrowser(deletedPath);
    const trigger = screen.getByRole("button", {
      name: `Switch file: ${deletedPath}`,
    });
    const dialog = await openPicker(deletedPath);
    fireEvent.contextMenu(
      within(dialog).getByRole("button", { name: /README.md/ }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "Delete File",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete File" }) === null,
      ).toBe(true),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/v1/assistants/{assistant_id}/workspace/delete",
        body: { path: deletedPath },
      }),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Nothing open yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose a file" })).toBe(trigger);
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    const reopened = await openPicker();
    expect(
      within(reopened).queryByRole("button", { name: /README.md/ }),
    ).toBeNull();
    expect(
      within(reopened).getByRole("button", { name: /config.json/ }),
    ).toBeTruthy();
  });

  test("wide panes keep the sidebar and hidden-file control", () => {
    hasRoomForList = true;
    renderBrowser();
    expect(screen.queryByRole("button", { name: "Choose a file" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show hidden files" }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search files" })).toBeTruthy();
  });
});
