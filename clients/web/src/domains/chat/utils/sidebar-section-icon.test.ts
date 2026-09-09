/**
 * The assistant-initiated section's header, which is the one section label
 * that is not a constant.
 */

import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_SECTION_LABEL,
  assistantSectionLabel,
} from "@/domains/chat/utils/sidebar-section-icon";

describe("assistantSectionLabel", () => {
  test("names the section after the assistant", () => {
    expect(assistantSectionLabel("Ada")).toBe("From Ada");
  });

  test("falls back before the assistant has a name", () => {
    // Either absence: never set, or cleared.
    expect(assistantSectionLabel(null)).toBe(ASSISTANT_SECTION_LABEL);
    expect(assistantSectionLabel(undefined)).toBe(ASSISTANT_SECTION_LABEL);
    expect(assistantSectionLabel("")).toBe(ASSISTANT_SECTION_LABEL);
  });

  test("falls back on a whitespace-only name", () => {
    // The name is user-entered, and "From " with nothing after it is worse
    // than either real option.
    expect(assistantSectionLabel("   ")).toBe(ASSISTANT_SECTION_LABEL);
  });

  test("trims a padded name rather than rendering the padding", () => {
    expect(assistantSectionLabel("  Ada  ")).toBe("From Ada");
  });
});
