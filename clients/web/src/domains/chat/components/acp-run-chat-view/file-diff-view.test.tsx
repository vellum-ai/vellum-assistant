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
    expect(ctx?.className).toContain("var(--content-tertiary)");
  });

  test("new file renders only additions", () => {
    const { container } = render(
      <FileDiffView path="new.ts" newText={"x\ny"} />,
    );
    expect(rowTypes(container)).toEqual(["add", "add"]);
  });
});
