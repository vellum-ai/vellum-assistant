/**
 * The back pill's two destination modes. A fixed destination is a link, so
 * the browser treats it as navigation; a pop-or-replace destination is a
 * plain button, so nothing moves before the handler picks where back goes.
 */
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { MobileTopBarBack } from "@/domains/intelligence/mobile-top-bar";

afterEach(cleanup);

const renderBack = (element: React.ReactElement) =>
  render(<MemoryRouter>{element}</MemoryRouter>);

test("a fixed destination renders a link to it", () => {
  const { container } = renderBack(
    <MobileTopBarBack
      ariaLabel="Back to Ada"
      tooltip="Back to Ada"
      to="/assistant/identity"
    />,
  );

  const link = container.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/assistant/identity");
  expect(link.getAttribute("aria-label")).toBe("Back to Ada");
  expect(container.querySelector("button")).toBeNull();
});

test("a handler renders a button that navigates nowhere on its own", () => {
  let pressed = 0;
  const { container } = renderBack(
    <MobileTopBarBack
      ariaLabel="Back to Contacts"
      tooltip="Back to Contacts"
      onClick={() => {
        pressed += 1;
      }}
    />,
  );

  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Back to Contacts");
  expect(container.querySelector("a")).toBeNull();
  fireEvent.click(button);
  expect(pressed).toBe(1);
});
