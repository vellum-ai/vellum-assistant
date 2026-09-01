/**
 * The typography lint rule is what stands between an invented variant name
 * and an element that silently renders at the inherited 16px/400. These
 * cover the edges the pattern is easy to get wrong on, so a later tweak
 * cannot quietly reopen any of them.
 */
/* eslint-disable no-restricted-syntax -- This file's fixtures are deliberately
   invalid variant names; they are the subject under test. Disabling here rather
   than exempting every test file from the rule keeps it active elsewhere, where
   a dead typography class would be a real defect worth catching. */

import { describe, expect, test } from "bun:test";

import { unknownTypographyPattern } from "./eslint.config.mjs";

const matches = (s: string) => new RegExp(unknownTypographyPattern).test(s);

describe("unknownTypographyPattern", () => {
  test("flags names that are not real variants", () => {
    for (const c of [
      "text-label-default",
      "text-label-small",
      "text-body-small",
      "text-body-medium-emphasised",
      "text-body-large-bold",
    ]) {
      expect(matches(c)).toBe(true);
    }
  });

  test("flags names merely prefixed by a real variant", () => {
    // The exemption must end where the variant ends. `\b` matches before a
    // hyphen, which let the hyphenated cases through; a boundary of
    // `[a-z-]` alone still let the digit and underscore cases through.
    for (const c of [
      "text-chat-foo",
      "text-body-small-default-typo",
      "text-title-small-ish",
      "text-title-small2",
      "text-chat_extra",
      "text-body-small-default9",
      "text-label-small-default_alt",
    ]) {
      expect(matches(c)).toBe(true);
    }
  });

  test("leaves every real variant alone, bare and inside a className", () => {
    for (const c of [
      "text-title-small",
      "text-body-small-default",
      "text-body-small-lighter",
      "text-label-medium-default",
      "text-chat",
      "rounded-full px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]",
    ]) {
      expect(matches(c)).toBe(false);
    }
  });

  test("leaves CSS custom-property rebinds alone", () => {
    // `camera-status-pill.tsx` rebinds the weight variable rather than
    // stacking a `font-semibold` that would race the utility on the same
    // property. The `text-` inside `--text-…` must not match.
    for (const c of [
      "[--text-label-medium-default-weight:600]",
      "[--text-body-small-default-size:13px]",
    ]) {
      expect(matches(c)).toBe(false);
    }
  });
});
