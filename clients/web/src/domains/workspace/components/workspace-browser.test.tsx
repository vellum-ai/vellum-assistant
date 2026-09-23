import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type * as SideListRoom from "@/hooks/use-side-list-room";
import { pressBackdrop } from "@/lib/overlay-test-helpers";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

import {
  seedWorkspaceStory,
  WORKSPACE_STORY_ASSISTANT_ID,
} from "../workspace-story-fixtures";

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

function HeaderTitle() {
  return useIntelligenceLayoutSlotsStore.use.headerTitle();
}

function renderBrowser(file?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedWorkspaceStory(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/assistant/workspace${file ? `?file=${file}` : ""}`]}
      >
        <HeaderTitle />
        <WorkspaceBrowser assistantId={WORKSPACE_STORY_ASSISTANT_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPicker(name = "Choose a file") {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name: "Files" });
}

beforeEach(() => {
  hasRoomForList = false;
});
afterEach(() => {
  cleanup();
  useIntelligenceLayoutSlotsStore.getState().setHeaderTitle(null);
});

describe("Workspace file switching", () => {
  test("the empty state's title opens an accessible sheet without focusing search", async () => {
    renderBrowser();
    expect(screen.getByText("Nothing open yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse files" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Choose a file" });
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
      "project-plan-with-a-long-descriptive-filename.md",
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
