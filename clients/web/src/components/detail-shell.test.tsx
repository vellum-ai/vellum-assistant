/**
 * The two header/body pieces every drawer panel draws from one place: the
 * quiet centred line an empty or failed body renders, and the "title · N"
 * cluster the header shows in place of a plain title.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  DetailShellNotice,
  DetailShellTitleWithCount,
} from "@/components/detail-shell";

afterEach(cleanup);

describe("DetailShellNotice", () => {
  test("renders the copy as a centred paragraph", () => {
    render(<DetailShellNotice>Nothing here yet</DetailShellNotice>);

    const notice = screen.getByText("Nothing here yet");
    expect(notice.tagName).toBe("P");
    expect(notice.className).toContain("text-center");
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
