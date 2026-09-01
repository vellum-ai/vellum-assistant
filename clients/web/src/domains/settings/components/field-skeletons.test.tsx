/**
 * The stand-in for the modal's Stripe inputs. Unlike the billing cards'
 * presentational skeletons it announces unconditionally: the modal is its own
 * surface, so there is no stack-level region to defer the announcement to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { FieldSkeletons, FIELD_STACK_CLASS } from "./field-skeletons";

afterEach(cleanup);

describe("FieldSkeletons", () => {
  test("announces the wait with its own translated label", () => {
    const { container } = render(<FieldSkeletons />);

    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-label")).toBe("Loading payment fields");
    expect(region?.getAttribute("data-testid")).toBe(
      "auto-top-up-pm-modal-skeleton",
    );
  });

  test("stands in for every field the mounted form renders", () => {
    const { container } = render(<FieldSkeletons />);

    // Card number, the expiry/CVC pair, then name, country and street.
    const placeholders = container.querySelectorAll('[data-slot="skeleton"]');
    expect(placeholders.length).toBe(6);
    for (const placeholder of placeholders) {
      // The labelled region is the one announcement; the rows are decoration.
      expect(placeholder.getAttribute("aria-hidden")).toBe("true");
      expect(placeholder.className).toContain("h-[42px]");
    }
  });

  test("carries the field-stack rhythm the mounted form is held to", () => {
    const { container } = render(<FieldSkeletons />);

    // The modal's form wrapper applies this same exported constant, so the
    // reveal cannot change the modal's height.
    const region = container.querySelector('[role="status"]');
    expect(region?.className).toBe(FIELD_STACK_CLASS);
  });
});
