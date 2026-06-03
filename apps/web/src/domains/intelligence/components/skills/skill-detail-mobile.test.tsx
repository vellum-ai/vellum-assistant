/**
 * Tests for `SkillDetailMobile` — the single-column phone skill-detail layout.
 *
 * The data hook (`useSkillDetailFiles`) is mocked so the component renders a
 * fixed set of file entries plus a markdown active file without touching React
 * Query or the daemon client. We verify the action bar wiring (back / remove),
 * the header content, and that the inline file dropdown lists the entries.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `apps/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type {
  SkillFileEntry,
  SkillInfo,
} from "@/domains/intelligence/skills/types.js";

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

const ACTIVE_FILE = FILE_ENTRIES[0];

mock.module("@/domains/intelligence/skills/use-skill-detail-files", () => ({
  useSkillDetailFiles: () => ({
    fileEntries: FILE_ENTRIES,
    skillMd: FILE_ENTRIES[0],
    selectedPath: null,
    setSelectedPath: () => {},
    activePath: ACTIVE_FILE.path,
    activeFile: ACTIVE_FILE,
    isFilesLoading: false,
    fileContent: "# Hello",
    isBinary: false,
    isContentLoading: false,
  }),
}));

const { SkillDetailMobile } = await import(
  "@/domains/intelligence/components/skills/skill-detail-mobile.js"
);

afterEach(() => {
  cleanup();
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
});
