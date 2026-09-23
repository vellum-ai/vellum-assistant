/**
 * Tests for `SkillFileContent`.
 *
 * A markdown file opens formatted and offers its source behind the shared
 * view-mode control; the source it shows is the file's own text, frontmatter
 * included. Binary files always show the binary-file message.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SkillFileContent } from "@/domains/intelligence/components/skills/skill-file-content.js";

const FILE = ["---", "name: Release triage", "---", "", "# Heading"].join("\n");

afterEach(() => {
  cleanup();
});

describe("SkillFileContent", () => {
  test("a markdown file opens formatted, with its metadata block undrawn", () => {
    render(
      <SkillFileContent fileName="readme.md" content={FILE} isBinary={false} />,
    );

    expect(screen.getByText("Heading")).toBeTruthy();
    expect(screen.queryByText(/name: Release triage/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  test("the source view shows the file's own text, frontmatter and all", () => {
    render(
      <SkillFileContent fileName="readme.md" content={FILE} isBinary={false} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("# Heading");
    expect(pre?.textContent).toContain("name: Release triage");
  });

  test("a file that is not markdown is source, which is all it has", () => {
    render(
      <SkillFileContent
        fileName="triage.py"
        content="print('hi')"
        isBinary={false}
      />,
    );

    expect(screen.queryByRole("radio", { name: "Source" })).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("print('hi')");
  });

  test("binary file shows the binary message", () => {
    render(
      <SkillFileContent fileName="logo.png" content={null} isBinary={true} />,
    );

    expect(screen.getByText("Binary file. No preview available.")).toBeTruthy();
  });
});
