import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

let electron = true;
let popout = false;
let announcementOpen = false;
let announcementReads = 0;

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));

mock.module("@/runtime/popout-window", () => ({
  isPopoutWindowLifetime: () => popout,
}));

mock.module("@/runtime/companion-intro-announcement", () => ({
  answerCompanionIntroAnnouncement: () => {},
  useCompanionIntroAnnouncement: () => {
    announcementReads += 1;
    return announcementOpen;
  },
}));

mock.module("@/components/companion-tour-entry", () => ({
  CompanionTourEntryModal: () => <div>Tour announcement</div>,
}));

const { CompanionTourEntry } =
  await import("@/components/companion-tour-entry-lazy");

beforeEach(() => {
  electron = true;
  popout = false;
  announcementOpen = false;
  announcementReads = 0;
});

afterEach(cleanup);

describe("CompanionTourEntry", () => {
  test("does not subscribe or render outside Electron", () => {
    electron = false;

    render(<CompanionTourEntry />);

    expect(announcementReads).toBe(0);
    expect(screen.queryByText("Tour announcement")).toBeNull();
  });

  test("does not subscribe or render in a pop-out window", () => {
    popout = true;

    render(<CompanionTourEntry />);

    expect(announcementReads).toBe(0);
    expect(screen.queryByText("Tour announcement")).toBeNull();
  });

  test("loads the modal only when the announcement is open", async () => {
    const view = render(<CompanionTourEntry />);

    expect(announcementReads).toBe(1);
    expect(screen.queryByText("Tour announcement")).toBeNull();

    announcementOpen = true;
    view.rerender(<CompanionTourEntry />);

    expect(await screen.findByText("Tour announcement")).toBeDefined();
  });
});
