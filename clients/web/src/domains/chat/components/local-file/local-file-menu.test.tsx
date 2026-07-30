import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const openWorkspaceFile = mock(async (_path: string) => {});
const downloadWorkspaceFile = mock(
  async (_opts: { assistantId: string; path: string; filename: string }) => {},
);

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));
mock.module("@/utils/download-workspace-file", () => ({
  downloadWorkspaceFile,
}));

const { LocalFileMenu } =
  await import("@/domains/chat/components/local-file/local-file-menu");

beforeEach(() => {
  openWorkspaceFile.mockClear();
  downloadWorkspaceFile.mockClear();
});

afterEach(() => {
  cleanup();
  // Radix locks body pointer events while a menu is open; a test that
  // leaves one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
});

async function openMenu(expectedItems = 2) {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "File actions" });
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getAllByRole("menuitem").length).toBe(expectedItems),
  );
  return user;
}

describe("LocalFileMenu", () => {
  test("exposes both actions with accessible names", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Go to file" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
  });

  test("Go to file opens the workspace path", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Go to file" }));

    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(openWorkspaceFile.mock.calls[0]![0]).toBe("scratch/report.pdf");
  });

  test("Download passes the assistant, path, and filename", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Download" }));

    await waitFor(() => expect(downloadWorkspaceFile).toHaveBeenCalledTimes(1));
    expect(downloadWorkspaceFile.mock.calls[0]![0]).toEqual({
      assistantId: "asst-1",
      path: "scratch/report.pdf",
      filename: "report.pdf",
    });
  });

  test("a null workspace path disables both actions", async () => {
    render(
      <LocalFileMenu
        workspacePath={null}
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    const user = await openMenu();
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.getAttribute("data-disabled")).not.toBeNull();
    }

    await user.click(screen.getByRole("menuitem", { name: "Go to file" }));
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  test("the disabled prop disables both actions", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/gone.pdf"
        filename="gone.pdf"
        assistantId="asst-1"
        disabled
      />,
    );

    await openMenu();
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.getAttribute("data-disabled")).not.toBeNull();
    }
  });

  test("download is disabled without an assistant to fetch from", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
      />,
    );

    await openMenu();

    expect(
      screen
        .getByRole("menuitem", { name: "Download" })
        .getAttribute("data-disabled"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Go to file" })
        .getAttribute("data-disabled"),
    ).toBeNull();
  });

  test("Picture in Picture is absent without a handler", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    await openMenu();

    expect(
      screen.queryByRole("menuitem", { name: "Picture in Picture" }),
    ).toBeNull();
  });

  test("Picture in Picture runs its handler", async () => {
    const onPictureInPicture = mock(() => {});
    render(
      <LocalFileMenu
        workspacePath="media/clip.mp4"
        filename="clip.mp4"
        assistantId="asst-1"
        onPictureInPicture={onPictureInPicture}
      />,
    );

    const user = await openMenu(3);
    await user.click(
      screen.getByRole("menuitem", { name: "Picture in Picture" }),
    );

    expect(onPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test("Picture in Picture stays enabled for an unavailable file", async () => {
    // It acts on the loaded video element, not on bytes read from disk.
    const onPictureInPicture = mock(() => {});
    render(
      <LocalFileMenu
        workspacePath={null}
        filename="clip.mp4"
        assistantId="asst-1"
        disabled
        onPictureInPicture={onPictureInPicture}
      />,
    );

    const user = await openMenu(3);
    const item = screen.getByRole("menuitem", { name: "Picture in Picture" });
    expect(item.getAttribute("data-disabled")).toBeNull();

    await user.click(item);
    expect(onPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test("the trigger opens on Enter", async () => {
    render(
      <LocalFileMenu
        workspacePath="scratch/report.pdf"
        filename="report.pdf"
        assistantId="asst-1"
      />,
    );

    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "File actions" });
    trigger.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
  });
});
