/**
 * The pill's contract: it says how far along the checklist is, it opens the
 * modal, and it offers no way to hide itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ActivationSuggestionsPill } from "@/domains/activation/components/activation-suggestions-pill";

afterEach(() => {
  cleanup();
});

describe("ActivationSuggestionsPill", () => {
  test("reads its progress out for assistive technology and on screen", () => {
    const { getByRole, getByText } = render(
      <ActivationSuggestionsPill done={1} total={3} onClick={() => {}} />,
    );
    expect(
      getByRole("button", { name: "Suggestions, 1 of 3 done" }),
    ).not.toBeNull();
    expect(getByText("1 of 3")).not.toBeNull();
  });

  test("opens the modal when activated", () => {
    let clicks = 0;
    const { getByRole } = render(
      <ActivationSuggestionsPill
        done={0}
        total={3}
        onClick={() => {
          clicks += 1;
        }}
      />,
    );
    fireEvent.click(getByRole("button"));
    expect(clicks).toBe(1);
  });

  /**
   * The pill is already the dismissed state and it retires itself on the third
   * completion, so a second way to hide it would only make the checklist
   * unreachable.
   */
  test("offers no dismiss control", () => {
    const { getAllByRole } = render(
      <ActivationSuggestionsPill done={1} total={3} onClick={() => {}} />,
    );
    expect(getAllByRole("button")).toHaveLength(1);
  });
});
