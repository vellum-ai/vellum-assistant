/**
 * The pieces every drawer panel draws from one place: the empty and loading
 * states, placed under a section heading or as the whole body, and the
 * "title · N" cluster the header shows in place of a plain title.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  DetailShellLoading,
  DetailShellNotice,
  DetailShellTitleWithCount,
} from "@/components/detail-shell";

afterEach(cleanup);

describe("DetailShellNotice", () => {
  test("under a section heading, reads left-aligned as the section's content", () => {
    render(
      <DetailShellNotice placement="section">
        Nothing here yet
      </DetailShellNotice>,
    );

    const notice = screen.getByText("Nothing here yet");
    expect(notice.tagName).toBe("P");
    expect(notice.className).not.toContain("text-center");
  });

  test("as the whole body, is centred", () => {
    render(
      <DetailShellNotice placement="panel">Nothing here yet</DetailShellNotice>,
    );

    expect(screen.getByText("Nothing here yet").className).toContain(
      "text-center",
    );
  });
});

describe("DetailShellLoading", () => {
  test("under a section heading, names what is loading beside the spinner", () => {
    render(<DetailShellLoading placement="section" label="Loading runs…" />);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading runs…");
  });

  test("as the whole body, the spinner stands alone and is labelled", () => {
    render(<DetailShellLoading placement="panel" />);

    const status = screen.getByRole("status", { name: "Loading…" });
    expect(status.textContent).toBe("");
  });
});

describe("DetailShellTitleWithCount", () => {
  test("renders the title, the dot, and the count", () => {
    const { container } = render(
      <DetailShellTitleWithCount title="Thinking" count="6 steps" />,
    );

    expect(screen.getByText("Thinking")).toBeDefined();
    expect(screen.getByText("6 steps")).toBeDefined();
    // The separator is decorative, so it is the one element with no text.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  test("lets the title truncate while the count stays whole", () => {
    const { container } = render(
      <DetailShellTitleWithCount
        title="A title long enough to need truncating"
        count="12"
      />,
    );

    const title = screen.getByText("A title long enough to need truncating");
    expect(title.className).toContain("truncate");
    expect(screen.getByText("12").className).toContain("shrink-0");
    expect(container.firstElementChild?.className).toContain("min-w-0");
  });
});
