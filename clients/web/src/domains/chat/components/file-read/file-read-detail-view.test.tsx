/**
 * Tests for `FileReadDetailView` — the nested detail shown when a subagent
 * `file_read` pill is clicked. Covers the basename helper, the file header
 * (name + full path), the content block, and the running/empty fallbacks.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import {
  basenameOf,
  FileReadDetailView,
} from "@/domains/chat/components/file-read/file-read-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
});

function payload(overrides: Partial<ToolDetailPayload>): ToolDetailPayload {
  return {
    toolCallId: "tu-fr",
    toolName: "file_read",
    title: "Reading",
    activity: "",
    input: {},
    status: "completed",
    kind: "tool",
    ...overrides,
  };
}

describe("basenameOf", () => {
  test("returns the trailing path segment", () => {
    expect(basenameOf("/a/b/c.txt")).toBe("c.txt");
    expect(basenameOf("data.txt")).toBe("data.txt");
    // Trailing slashes are ignored.
    expect(basenameOf("/a/b/")).toBe("b");
  });
});

describe("FileReadDetailView", () => {
  test("renders the basename header, the full path, and the file contents", () => {
    const { getByText, getByTitle, container } = render(
      <FileReadDetailView
        detail={payload({
          input: { path: "/Users/x/.vellum/workspace/data.txt" },
          result: "line one\nline two",
        })}
      />,
    );

    // Basename as the heading, full path beneath.
    expect(getByText("data.txt")).toBeDefined();
    expect(
      getByTitle("/Users/x/.vellum/workspace/data.txt"),
    ).toBeDefined();
    // Contents render verbatim in the code block.
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
  });

  test("shows a 'Reading…' fallback while running with no result yet", () => {
    const { getByText } = render(
      <FileReadDetailView
        detail={payload({ input: { path: "/x/f.txt" }, status: "running", result: undefined })}
      />,
    );
    expect(getByText("Reading…")).toBeDefined();
  });
});
