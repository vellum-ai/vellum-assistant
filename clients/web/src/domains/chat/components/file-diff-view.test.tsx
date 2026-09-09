import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { FileDiffView } from "./file-diff-view";

afterEach(cleanup);

function rowTypes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-diff-type]")).map(
    (el) => el.getAttribute("data-diff-type") ?? "",
  );
}

describe("FileDiffView", () => {
  test("exposes the file path as an a11y label", () => {
    render(<FileDiffView path="src/foo.ts" oldText="a" newText="a" />);
    expect(screen.getByLabelText("Diff for src/foo.ts")).toBeDefined();
  });

  test("renders add/del/ctx rows with token-class surfaces", () => {
    const { container } = render(
      <FileDiffView
        path="src/foo.ts"
        oldText={"a\nb\nc"}
        newText={"a\nB\nc"}
      />,
    );

    expect(rowTypes(container)).toEqual(["ctx", "del", "add", "ctx"]);

    const del = container.querySelector('[data-diff-type="del"]');
    const add = container.querySelector('[data-diff-type="add"]');
    expect(del?.className).toContain("var(--system-negative-weak)");
    expect(del?.className).toContain("var(--system-negative-strong)");
    expect(add?.className).toContain("var(--system-positive-weak)");
    expect(add?.className).toContain("var(--system-positive-strong)");

    const ctx = container.querySelector('[data-diff-type="ctx"]');
    expect(ctx?.className).toContain("var(--content-secondary)");
  });

  test("new file renders only additions with an empty old-side gutter", () => {
    const { container } = render(
      <FileDiffView path="new.ts" newText={"x\ny"} />,
    );
    expect(rowTypes(container)).toEqual(["add", "add"]);

    const cells = container
      .querySelector('[data-diff-type="add"]')
      ?.querySelectorAll("span");
    expect(cells?.[0]?.textContent).toBe("");
    expect(cells?.[1]?.textContent).toBe("1");
  });

  test("deleted file renders only deletions with an empty new-side gutter", () => {
    const { container } = render(
      <FileDiffView path="gone.ts" oldText={"x\ny"} />,
    );
    expect(rowTypes(container)).toEqual(["del", "del"]);

    const cells = container
      .querySelector('[data-diff-type="del"]')
      ?.querySelectorAll("span");
    expect(cells?.[0]?.textContent).toBe("1");
    expect(cells?.[1]?.textContent).toBe("");
  });

  test("oversized input renders the too-large notice instead of rows", () => {
    const { container } = render(
      <FileDiffView path="big.ts" oldText={"x\n".repeat(2001)} newText="y" />,
    );

    const notice = container.querySelector('[data-diff-type="too-large"]');
    expect(notice?.textContent).toContain("Diff too large to render");
    expect(rowTypes(container)).toEqual(["too-large"]);
  });
});
