import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const openWorkspaceFile = mock(async (_path: string) => {});
const downloadLocalFile = mock(
  async (_opts: { assistantId: string; path: string; filename: string }) => {},
);

mock.module("@/utils/open-workspace-file", () => ({ openWorkspaceFile }));
mock.module("@/domains/chat/components/local-file/download-local-file", () => ({
  downloadLocalFile,
}));

const { LocalFileMenu } =
  await import("@/domains/chat/components/local-file/local-file-menu");

beforeEach(() => {
  openWorkspaceFile.mockClear();
  downloadLocalFile.mockClear();
});

afterEach(() => {
  cleanup();
  // Radix locks body pointer events while a menu is open; a test that
  // leaves one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
});

async function openMenu() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "File actions" });
  await user.click(trigger);
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
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

    await waitFor(() => expect(downloadLocalFile).toHaveBeenCalledTimes(1));
    expect(downloadLocalFile.mock.calls[0]![0]).toEqual({
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
