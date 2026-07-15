import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Notice } from "./notice";

describe("Notice — error tone icon", () => {
  test("renders TriangleAlert on the error tone", () => {
    const html = renderToStaticMarkup(
      <Notice tone="error">Something went wrong.</Notice>,
    );

    expect(html).toContain("lucide-triangle-alert");
    expect(html).not.toContain("lucide-octagon-x");
  });

  test("TriangleAlert is rendered for error even when title and children are absent", () => {
    const html = renderToStaticMarkup(<Notice tone="error" />);
    expect(html).toContain("lucide-triangle-alert");
  });

  test("icon={null} suppresses the default error TriangleAlert", () => {
    const html = renderToStaticMarkup(
      <Notice tone="error" icon={null}>
        Something went wrong.
      </Notice>,
    );

    expect(html).not.toContain("lucide-triangle-alert");
  });
});

describe("Notice — hint tone", () => {
  test("renders the Lightbulb icon and hint container classes", () => {
    const html = renderToStaticMarkup(
      <Notice tone="hint">Try keyboard shortcuts.</Notice>,
    );

    expect(html).toContain("lucide-lightbulb");
    expect(html).toContain("var(--system-info-weak)");
  });

  test("icon={null} suppresses the default hint Lightbulb", () => {
    const html = renderToStaticMarkup(
      <Notice tone="hint" icon={null}>
        Try keyboard shortcuts.
      </Notice>,
    );

    expect(html).not.toContain("lucide-lightbulb");
  });
});
