/**
 * Tests for `SkillFileContent` view-mode rendering.
 *
 * A markdown file renders as rendered HTML in "preview" mode (no `<pre>`) and
 * as raw source inside a `<pre>` in "raw" mode. Binary files always show the
 * binary-file message.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `apps/web/test-setup.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { SkillFileContent } from "@/domains/intelligence/components/skills/skill-file-content.js";

afterEach(() => {
  cleanup();
});

describe("SkillFileContent", () => {
  test("markdown preview renders rendered markdown without a <pre>", () => {
    render(
      <SkillFileContent
        fileName="readme.md"
        content="# Heading"
        isBinary={false}
        viewMode="preview"
      />,
    );

    expect(screen.getByText("Heading")).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();
  });

  test("markdown raw renders the source inside a <pre>", () => {
    render(
      <SkillFileContent
        fileName="readme.md"
        content="# Heading"
        isBinary={false}
        viewMode="raw"
      />,
    );

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("# Heading");
  });

  test("binary file shows the binary message", () => {
    render(
      <SkillFileContent
        fileName="logo.png"
        content={null}
        isBinary={true}
      />,
    );

    expect(screen.getByText("Binary file — no preview available.")).toBeTruthy();
  });
});
