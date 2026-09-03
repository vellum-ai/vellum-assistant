/**
 * What the Inspiration List owes its reader: every task of the list in catalog
 * order, a title that counts them, and a click that does the right thing for
 * the state each row is in.
 *
 * The page is presentational, so nothing is mocked here. The catalog is the
 * real one and the progress is the wire shape the daemon returns, which is the
 * only pairing that can prove a row reads its own record.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_LIST_MIXED,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import { getActivationList } from "@/domains/activation/catalog";
import { ActivationListPage } from "@/domains/activation/components/activation-list-page";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";

const { starters, items } = getActivationList("smb");
const TASKS = [...starters, ...items];

const launched: string[] = [];
const opened: string[] = [];

function renderPage(progress: ActivationProgress = ACTIVATION_PROGRESS_EMPTY) {
  return render(
    <ActivationListPage
      tasks={TASKS}
      progress={progress.tasks}
      onLaunch={(taskId) => launched.push(taskId)}
      onOpenConversation={(conversationId) => opened.push(conversationId)}
    />,
  );
}

/** The row whose title is `title`, as a clickable element. */
function rowButton(title: string): HTMLElement {
  const button = screen.getByText(title).closest("button");
  if (!button) {
    throw new Error(`No row button for "${title}"`);
  }
  return button;
}

afterEach(() => {
  cleanup();
  launched.length = 0;
  opened.length = 0;
});

describe("ActivationListPage", () => {
  test("renders the whole list, starters first, and counts it in the title", () => {
    renderPage();

    expect(
      screen.getByRole("heading", {
        name: `Your first ${TASKS.length} things`,
      }),
    ).toBeTruthy();

    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBe(TASKS.length);
    // Catalog order, which puts the three starters at the top (PLAN A10).
    expect(rows[0]?.textContent).toContain(starters[0]?.title ?? "");
    expect(rows[3]?.textContent).toContain(items[0]?.title ?? "");
  });

  test("clicking an untouched row launches it and stays on the page", () => {
    renderPage();

    fireEvent.click(rowButton(starters[0]?.title ?? ""));

    expect(launched).toEqual([FIXTURE_STARTER_IDS[0]]);
    expect(opened).toEqual([]);
  });

  test("clicking a finished row opens its conversation instead", () => {
    renderPage(ACTIVATION_PROGRESS_LIST_MIXED);

    fireEvent.click(rowButton(starters[0]?.title ?? ""));

    expect(opened).toEqual(["conv-done-1"]);
    expect(launched).toEqual([]);
  });

  test("clicking a running row opens its conversation too", () => {
    renderPage(ACTIVATION_PROGRESS_LIST_MIXED);

    fireEvent.click(rowButton(starters[1]?.title ?? ""));

    expect(opened).toEqual(["conv-started-2"]);
  });

  test("each finished row shows what it produced", () => {
    renderPage(ACTIVATION_PROGRESS_LIST_MIXED);

    // A turn that attached a file shows the file; one that did not falls back
    // to the "Done · N steps" pill (PLAN A6).
    expect(screen.getByText("proposal-aug2026.pdf")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("4 steps")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("2 steps")).toBeTruthy();
  });

  test("a launch in flight reads as working and cannot be fired twice", () => {
    render(
      <ActivationListPage
        tasks={TASKS}
        progress={{}}
        pendingTaskId={FIXTURE_STARTER_IDS[0]}
        onLaunch={(taskId) => launched.push(taskId)}
        onOpenConversation={(conversationId) => opened.push(conversationId)}
      />,
    );

    expect(screen.getByText("Working")).toBeTruthy();
    fireEvent.click(rowButton(starters[0]?.title ?? ""));
    expect(launched).toEqual([]);
  });
});

describe("ActivationListPage external links", () => {
  const linked = TASKS.find((task) => task.link);

  test("a task with a call to action renders it under the description", () => {
    expect(linked).toBeTruthy();
    renderPage();

    const anchor = screen.getByRole("link", { name: /.+/ });
    expect(anchor.getAttribute("href")).toBe(linked?.link?.url ?? null);
    // It leaves the app, so it gets the hardening every external link gets.
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("the desktop app drops it: it already is the download", async () => {
    mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
    const { ActivationListPage: ElectronPage } = await import(
      "@/domains/activation/components/activation-list-page"
    );

    render(
      <ElectronPage
        tasks={TASKS}
        progress={{}}
        onLaunch={() => {}}
        onOpenConversation={() => {}}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    mock.restore();
  });
});
