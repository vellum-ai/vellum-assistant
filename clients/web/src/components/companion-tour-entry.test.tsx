import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { CompanionTourEntryModal } from "./companion-tour-entry";

afterEach(cleanup);

describe("CompanionTourEntryModal", () => {
  test("moves focus inside the dialog when it opens", async () => {
    const view = render(
      <>
        <button type="button">Background action</button>
        <CompanionTourEntryModal
          open={false}
          onStart={() => {}}
          onDismiss={() => {}}
        />
      </>,
    );
    view.getByText("Background action").focus();

    view.rerender(
      <>
        <button type="button">Background action</button>
        <CompanionTourEntryModal open onStart={() => {}} onDismiss={() => {}} />
      </>,
    );

    await waitFor(() => {
      expect(view.getByRole("dialog").contains(document.activeElement)).toBe(
        true,
      );
    });
  });

  test("starts the tour from the announcement", () => {
    const onStart = mock(() => {});
    const view = render(
      <CompanionTourEntryModal open onStart={onStart} onDismiss={() => {}} />,
    );

    fireEvent.click(view.getByText("Start the tour"));

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("asks for confirmation before dismissing", () => {
    const onDismiss = mock(() => {});
    const view = render(
      <CompanionTourEntryModal open onStart={() => {}} onDismiss={onDismiss} />,
    );

    fireEvent.click(view.getByLabelText("Close"));

    expect(view.getByText("Skip the tour?")).toBeDefined();
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(view.getByText("Skip for now"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("can continue the tour from the dismissal confirmation", () => {
    const onStart = mock(() => {});
    const view = render(
      <CompanionTourEntryModal open onStart={onStart} onDismiss={() => {}} />,
    );

    fireEvent.click(view.getByLabelText("Close"));
    fireEvent.click(view.getByText("Take the tour"));

    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
