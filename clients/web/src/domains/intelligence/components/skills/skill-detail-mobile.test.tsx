/**
 * Tests for `SkillDetailMobile` — the single-column phone skill-detail layout.
 *
 * The data hook (`useSkillDetailFiles`) is mocked so the component renders a
 * fixed set of file entries plus an active file without touching React Query or
 * the daemon client. A mutable `hookState` lets individual tests swap the active
 * file (markdown vs non-markdown). We verify the action bar wiring (back /
 * remove), the header content, the inline file dropdown, and the Preview/Source
 * segment control.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { SkillInfo } from "@/domains/intelligence/skills/types.js";
import type { SkillFileEntry } from "@/hooks/use-skill-detail-files.js";

const FILE_ENTRIES: SkillFileEntry[] = [
  {
    name: "SKILL.md",
    path: "SKILL.md",
    mimeType: "text/markdown",
    size: 7,
    isBinary: false,
    content: "# Hello",
  },
  {
    name: "helper.py",
    path: "helper.py",
    mimeType: "text/x-python",
    size: 0,
    isBinary: false,
    content: null,
  },
];

const MARKDOWN_FILE = FILE_ENTRIES[0];

const JSON_FILE: SkillFileEntry = {
  name: "data.json",
  path: "data.json",
  mimeType: "application/json",
  size: 13,
  isBinary: false,
  content: '{"hi":true}',
};

// Mutable so individual tests can swap the active file (markdown vs not).
const hookState: {
  activeFile: SkillFileEntry;
  activePath: string;
  fileContent: string;
} = {
  activeFile: MARKDOWN_FILE,
  activePath: MARKDOWN_FILE.path,
  fileContent: "# Hello",
};

function setActiveFile(file: SkillFileEntry): void {
  hookState.activeFile = file;
  hookState.activePath = file.path;
  hookState.fileContent = file.content ?? "";
}

mock.module("@/hooks/use-skill-detail-files", () => ({
  useSkillDetailFiles: () => ({
    fileEntries: FILE_ENTRIES,
    skillMd: FILE_ENTRIES[0],
    selectedPath: null,
    setSelectedPath: () => {},
    activePath: hookState.activePath,
    activeFile: hookState.activeFile,
    isFilesLoading: false,
    isFilesPending: false,
    fileContent: hookState.fileContent,
    isBinary: false,
    isContentLoading: false,
    isContentPending: false,
  }),
}));

const { SkillDetailMobile } = await import(
  "@/domains/intelligence/components/skills/skill-detail-mobile.js"
);

afterEach(() => {
  cleanup();
  setActiveFile(MARKDOWN_FILE);
});

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "skill-1",
    name: "Test Skill",
    description: "A skill used in mobile detail tests",
    emoji: "\u{1F9E9}",
    kind: "installed",
    status: "enabled",
    origin: "custom",
    category: "general",
    ...overrides,
  };
}

function getButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) {
    throw new Error(`expected a button with aria-label="${label}"`);
  }
  return match;
}

describe("SkillDetailMobile", () => {
  test("back button calls onBack", () => {
    const onBack = mock(() => {});

    render(<SkillDetailMobile assistantId="asst-1" skill={makeSkill()} onBack={onBack} />);

    fireEvent.click(getButton("Back to skills"));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("removable skill: remove button calls onRemove", () => {
    const onRemove = mock(() => {});

    render(
      <SkillDetailMobile
        assistantId="asst-1"
        skill={makeSkill({ kind: "installed" })}
        onBack={() => {}}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(getButton("Remove skill"));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test("renders the title and full description", () => {
    render(
      <SkillDetailMobile
        assistantId="asst-1"
        skill={makeSkill({
          name: "My Skill",
          description: "A long description that should not be clamped.",
        })}
        onBack={() => {}}
      />,
    );

    // Title appears both in the action bar and the header block.
    expect(screen.getAllByText("My Skill").length).toBeGreaterThan(0);
    expect(
      screen.getByText("A long description that should not be clamped."),
    ).toBeTruthy();
  });

  test("file dropdown lists the provided file names", () => {
    render(
      <SkillDetailMobile assistantId="asst-1" skill={makeSkill()} onBack={() => {}} />,
    );

    // Open the inline file menu via its trigger (shows the active file name).
    // Radix's dropdown trigger opens on pointer-down / keyboard, not a bare
    // click, so drive it with a keyboard activation.
    const trigger = screen.getByText("SKILL.md").closest("button");
    if (!trigger) {
      throw new Error("expected a file dropdown trigger button");
    }
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(screen.getByText("helper.py")).toBeTruthy();
  });

  test("markdown file: toggles between rendered preview and raw source", () => {
    render(
      <SkillDetailMobile assistantId="asst-1" skill={makeSkill()} onBack={() => {}} />,
    );

    // Default is preview: rendered markdown (no raw <pre>, heading text shown).
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("Hello")).toBeTruthy();

    // Switch to Source: raw <pre> with the markdown source text.
    fireEvent.click(getButton("Source"));
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("# Hello");

    // Switch back to Preview: rendered markdown again.
    fireEvent.click(getButton("Preview"));
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  test("non-markdown file: Preview disabled and content shows as source", () => {
    setActiveFile(JSON_FILE);

    render(
      <SkillDetailMobile assistantId="asst-1" skill={makeSkill()} onBack={() => {}} />,
    );

    expect(getButton("Preview").disabled).toBe(true);

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('{"hi":true}');
  });
});
