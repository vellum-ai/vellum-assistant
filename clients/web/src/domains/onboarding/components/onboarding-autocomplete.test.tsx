import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { TagAutocompleteInput } from "@/domains/onboarding/components/onboarding-autocomplete";

afterEach(cleanup);

describe("TagAutocompleteInput", () => {
  test("claims Escape only while its suggestion list is open", () => {
    render(
      <TagAutocompleteInput
        label="Interests"
        values={[]}
        onChange={() => {}}
        suggestions={["Music"]}
      />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");

    const closeEvent = createEvent.keyDown(input, {
      key: "Escape",
      cancelable: true,
    });
    fireEvent(input, closeEvent);
    expect(closeEvent.defaultPrevented).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    const closedEvent = createEvent.keyDown(input, {
      key: "Escape",
      cancelable: true,
    });
    fireEvent(input, closedEvent);
    expect(closedEvent.defaultPrevented).toBe(false);
  });
});
