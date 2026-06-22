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
