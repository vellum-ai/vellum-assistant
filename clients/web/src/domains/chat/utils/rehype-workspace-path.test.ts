import { describe, expect, test } from "bun:test";

import { rehypeWorkspacePath } from "@/domains/chat/utils/rehype-workspace-path";
import { WORKSPACE_PATH_TAG } from "@/domains/chat/utils/workspace-path-links";

interface TestElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: TestNode[];
}
type TestNode = TestElement | { type: "text"; value: string };

function code(value: string): TestElement {
  return {
    type: "element",
    tagName: "code",
    children: [{ type: "text", value }],
  };
}

function tree(...children: TestNode[]): TestElement {
  return { type: "element", tagName: "root", children };
}

function run(root: TestElement): TestElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rehypeWorkspacePath()(root as any);
  return root;
}

describe("rehypeWorkspacePath", () => {
  test("upgrades an inline code span holding a workspace path", () => {
    const span = code("/workspace/drafts/notes.md");
    run(tree({ type: "element", tagName: "p", children: [span] }));

    expect(span.tagName).toBe(WORKSPACE_PATH_TAG);
    expect(span.properties).toEqual({
      path: "drafts/notes.md",
      raw: "/workspace/drafts/notes.md",
    });
    // The label comes from `raw`; leftover children would double-render it.
    expect(span.children).toEqual([]);
  });

  test("leaves non-path code spans alone", () => {
    const span = code("bun test");
    run(tree({ type: "element", tagName: "p", children: [span] }));

    expect(span.tagName).toBe("code");
    expect(span.properties).toBeUndefined();
  });

  test("skips fenced code blocks", () => {
    // Fenced blocks arrive as <pre><code>; a path quoted in a shell transcript
    // is content being shown, not a file to click.
    const span = code("/workspace/drafts/notes.md");
    run(
      tree({
        type: "element",
        tagName: "pre",
        children: [span],
      }),
    );

    expect(span.tagName).toBe("code");
  });

  test("skips code inside a link", () => {
    // The resolved element is a button, which is invalid inside an anchor.
    const span = code("/workspace/drafts/notes.md");
    run(
      tree({
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com" },
        children: [span],
      }),
    );

    expect(span.tagName).toBe("code");
  });

  test("descends into nested containers", () => {
    const span = code("/workspace/drafts/notes.md");
    run(
      tree({
        type: "element",
        tagName: "ul",
        children: [
          {
            type: "element",
            tagName: "li",
            children: [{ type: "element", tagName: "p", children: [span] }],
          },
        ],
      }),
    );

    expect(span.tagName).toBe(WORKSPACE_PATH_TAG);
  });

  test("leaves structured (multi-child) code spans alone", () => {
    const span: TestElement = {
      type: "element",
      tagName: "code",
      children: [
        { type: "text", value: "/workspace/" },
        { type: "element", tagName: "em", children: [] },
        { type: "text", value: "drafts/notes.md" },
      ],
    };
    run(tree({ type: "element", tagName: "p", children: [span] }));

    expect(span.tagName).toBe("code");
  });

  test("upgrades every qualifying span in a message", () => {
    const first = code("/workspace/drafts/v0.10.11-notes.md");
    const second = code("/workspace/drafts/v0.10.12-notes.md");
    run(
      tree({
        type: "element",
        tagName: "p",
        children: [first, { type: "text", value: " and " }, second],
      }),
    );

    expect(first.tagName).toBe(WORKSPACE_PATH_TAG);
    expect(second.tagName).toBe(WORKSPACE_PATH_TAG);
  });
});
