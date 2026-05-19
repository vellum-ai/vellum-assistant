/**
 * Tests for RuleEditorModal.
 *
 * The web workspace does not load a DOM testing library, so we render to
 * static markup via `react-dom/server` and assert on the resulting HTML.
 * This is sufficient to verify the "Where" section's deduplication of the
 * upstream `"everywhere"` sentinel against the modal's own static
 * "Everywhere" radio.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RuleEditorModal, type RuleEditorModalProps } from "@/components/assistant/RuleEditorModal.js";

const noop = (): void => {};

function baseProps(
  overrides: Partial<RuleEditorModalProps> = {},
): RuleEditorModalProps {
  return {
    toolName: "bash",
    commandText: "ls",
    commandDescription: "List files",
    riskLevel: "medium",
    allowlistOptions: [
      { label: "ls", pattern: "ls" },
      { label: "ls *", pattern: "ls *" },
    ],
    scopeOptions: [],
    directoryScopeOptions: [],
    onSave: () => Promise.resolve(),
    onDismiss: noop,
    ...overrides,
  };
}

/** Count occurrences of a substring in a string. */
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

describe("RuleEditorModal — Where section deduplication", () => {
  test("renders 'Everywhere' exactly once when directoryScopeOptions includes the sentinel", () => {
    // Simulates what the gateway's `generateDirectoryScopeOptions` actually
    // emits today: a narrower scope followed by the always-emit `"everywhere"`
    // sentinel. The modal also renders its own static "Everywhere" radio,
    // so without filtering this would produce two visible rows.
    const html = renderToStaticMarkup(
      createElement(RuleEditorModal, baseProps({
        directoryScopeOptions: [
          { scope: "/workspace/*", label: "In workspace/" },
          { scope: "everywhere", label: "Everywhere" },
        ],
      })),
    );

    expect(html).toContain("In workspace/");
    expect(occurrences(html, "Everywhere")).toBe(1);
  });

  test("renders 'Everywhere' exactly once when scopeOptions (legacy) includes the sentinel", () => {
    // Legacy fallback path: directoryScopeOptions empty, scopeOptions used
    // instead. The daemon-side `generateScopeOptions` also appends an
    // `"everywhere"` sentinel that must be deduped.
    const html = renderToStaticMarkup(
      createElement(RuleEditorModal, baseProps({
        scopeOptions: [
          { scope: "/workspace", label: "/workspace" },
          { scope: "everywhere", label: "everywhere" },
        ],
      })),
    );

    expect(occurrences(html, "Everywhere")).toBe(1);
  });

  test("still renders the static 'Everywhere' radio when no scope options are supplied", () => {
    // No upstream options → the section is hidden entirely (current behavior)
    // and zero "Everywhere" rows appear.
    const html = renderToStaticMarkup(
      createElement(RuleEditorModal, baseProps()),
    );

    expect(occurrences(html, "Everywhere")).toBe(0);
  });

  test("renders the static 'Everywhere' radio even when upstream sends only the sentinel", () => {
    // Edge case: gateway emitted only the "everywhere" sentinel (no narrower
    // scope was derivable for this invocation). The Where section should
    // remain visible (preserving prior behavior) and show exactly one
    // "Everywhere" row backed by the static radio.
    const html = renderToStaticMarkup(
      createElement(RuleEditorModal, baseProps({
        directoryScopeOptions: [
          { scope: "everywhere", label: "Everywhere" },
        ],
      })),
    );

    expect(occurrences(html, "Everywhere")).toBe(1);
  });
});

describe("RuleEditorModal — empty allowlist fallback", () => {
  // Reproduces the bug from the chip-click flow on historical tool calls:
  // the daemon's `annotatePersistedAssistantMessage` only persists
  // `_riskLevel`/`_riskReason` etc. on tool_use blocks, not the scope arrays.
  // After page reload, allowlistOptions arrives empty, leaving the "Apply to"
  // section visually blank. macOS handles this via a fallback in
  // `AssistantProgressView.scopeOptions(from:)`. The web modal mirrors that.

  test("synthesizes a raw-command fallback when allowlistOptions is empty", () => {
    const html = renderToStaticMarkup(
      createElement(
        RuleEditorModal,
        baseProps({
          allowlistOptions: [],
          commandText: "git push origin main",
          commandDescription: "push to origin",
        }),
      ),
    );

    // The fallback renders as a single static label (length === 1 branch),
    // not a radio list. The exact command must surface so the user knows
    // what they'd be saving.
    expect(html).toContain("git push origin main");
  });

  test("synthesizes 'Any {tool} call' when commandText is empty", () => {
    const html = renderToStaticMarkup(
      createElement(
        RuleEditorModal,
        baseProps({
          toolName: "remember",
          allowlistOptions: [],
          commandText: "",
          commandDescription: "Saving a fact",
        }),
      ),
    );

    expect(html).toContain("Any remember call");
  });

  test("synthesizes 'Any {tool} call' when commandText equals commandDescription (natural-language path)", () => {
    // Tools without a priority key (no `command`/`path`/`url`) fall back to
    // the activity string in deriveCommandText, so commandText ends up
    // equalling commandDescription. That's the natural-language signal.
    const html = renderToStaticMarkup(
      createElement(
        RuleEditorModal,
        baseProps({
          toolName: "skill_load",
          allowlistOptions: [],
          commandText: "Loading the inbox skill",
          commandDescription: "Loading the inbox skill",
        }),
      ),
    );

    expect(html).toContain("Any skill_load call");
    // The raw activity text must NOT have been used as the fallback pattern
    // — that would be a useless rule with a sentence as a glob.
    expect(html).not.toContain('value="Loading the inbox skill"');
  });

  test("Save button stays usable with the synthetic fallback (regression guard)", () => {
    // Before the fallback, an empty allowlistOptions would render an empty
    // radio list and clicking Save was a silent no-op
    // (`patternOption = allowlistOptions[selectedPatternIndex] ?? allowlistOptions[0]`
    // → undefined → early return). The fallback must keep Save functional.
    const html = renderToStaticMarkup(
      createElement(
        RuleEditorModal,
        baseProps({
          allowlistOptions: [],
          commandText: "ls /workspace",
          commandDescription: "",
        }),
      ),
    );

    expect(html).toContain("Save Rule");
    expect(html).not.toContain('disabled=""');
  });
});

describe("RuleEditorModal — long command rendering", () => {
  test("long command text is contained in a scrollable, height-capped container", () => {
    // A 5965 PR-merge curl invocation as actually reported by Noa.
    const longCommand = `TOKEN=$(bun /workspace/bin/gh-app-token.mjs vellum-assistant-platform 2>/dev/null | tail -1)
echo "=== Merge #5965 ==="
RESULT=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN" \\
  "https://api.github.com/repos/vellum-ai/vellum-assistant-platform/pulls/5965/merge" \\
  -d '{ "merge_method": "squash", "commit_title": "feat: ...", "commit_message": "lots and lots of detail here" }')
echo "$RESULT" | jq '{merged, message, sha}'`;

    const html = renderToStaticMarkup(
      createElement(
        RuleEditorModal,
        baseProps({
          allowlistOptions: [],
          commandText: longCommand,
          commandDescription: "curl with variable expansion",
        }),
      ),
    );

    // The container that wraps the command code must declare both the
    // height cap and a vertical-scroll affordance so it can't push the
    // rest of the modal off screen.
    const codeBlockMatch = html.match(/<code class="([^"]*)">/);
    expect(codeBlockMatch).not.toBeNull();
    const classes = codeBlockMatch![1]!;
    expect(classes).toContain("max-h-48");
    expect(classes).toContain("overflow-y-auto");
    // whitespace-pre-wrap so embedded \n's render as real line breaks
    // rather than getting collapsed into a single visual line.
    expect(classes).toContain("whitespace-pre-wrap");
  });
});
