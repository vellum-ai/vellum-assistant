import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { CompanionTourEntryModal } from "./companion-tour-entry";

afterEach(cleanup);

describe("CompanionTourEntryModal", () => {
  test("previews the assistant's own image and updates when it changes", () => {
    const avatar = {
      customImageUrl: "https://example.com/assistant-avatar.png",
      components: null,
      traits: null,
      accentHex: "#e7652a",
    };
    const view = render(
      <CompanionTourEntryModal
        open
        avatar={avatar}
        assistantName="Example Assistant"
        onStart={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      view
        .getByRole("dialog")
        .querySelector(`img[src="${avatar.customImageUrl}"]`),
    ).not.toBeNull();
    expect(view.getByRole("dialog").innerHTML).toContain(avatar.accentHex);
    view.rerender(
      <CompanionTourEntryModal
        open
        avatar={{
          ...avatar,
          customImageUrl: "https://example.com/updated-avatar.png",
        }}
        onStart={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      view
        .getByRole("dialog")
        .querySelector('img[src="https://example.com/updated-avatar.png"]'),
    ).not.toBeNull();
    expect(
      view
        .getByRole("dialog")
        .querySelector(`img[src="${avatar.customImageUrl}"]`),
    ).toBeNull();
  });

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

  test("dismisses immediately when Close is pressed", () => {
    const onDismiss = mock(() => {});
    const view = render(
      <CompanionTourEntryModal open onStart={() => {}} onDismiss={onDismiss} />,
    );
    fireEvent.click(view.getByLabelText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(view.queryByText("Skip the tour?")).toBeNull();
  });

  test("dismisses immediately when Escape is pressed", () => {
    const onDismiss = mock(() => {});
    const view = render(
      <CompanionTourEntryModal open onStart={() => {}} onDismiss={onDismiss} />,
    );
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
