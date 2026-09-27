import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  ChatsSettingsModal,
  type ChatsSettingsModalProps,
  type ChatsSettingsValues,
} from "./chats-settings-modal";

const DEFAULTS: ChatsSettingsValues = {
  autoArchive: { enabled: false, afterDays: 7 },
  newMessageEnabled: true,
};

afterEach(cleanup);

function setup(overrides: Partial<ChatsSettingsModalProps> = {}) {
  const props: ChatsSettingsModalProps = {
    open: true,
    onOpenChange: mock(() => {}),
    state: { status: "ready", values: DEFAULTS },
    saveStatus: "idle",
    onSave: mock(() => {}),
    onRetryLoad: mock(() => {}),
    ...overrides,
  };
  const view = render(<ChatsSettingsModal {...props} />);
  return {
    ...view,
    props,
    update: (next: Partial<ChatsSettingsModalProps>) =>
      view.rerender(<ChatsSettingsModal {...props} {...next} />),
  };
}

function clickBackdrop() {
  const overlay = document.querySelector('[data-slot="modal-overlay"]')!;
  fireEvent.pointerDown(overlay);
  fireEvent.pointerUp(overlay);
  fireEvent.click(overlay);
}

describe("ChatsSettingsModal", () => {
  test("labels controls and starts with no writable changes", () => {
    const view = setup();
    expect(view.getByRole("dialog", { name: "Chats Settings" })).toBeDefined();
    const toggle = view.getByRole("switch", { name: "Auto Archive Chats" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("Done chats stay in All Chats");
    expect(
      view
        .getByRole("combobox", { name: "Time to Archive" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("Confirm submits only changed leaves and leaves closing to successful save", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledTimes(1);
    expect(view.props.onSave).toHaveBeenCalledWith({
      conversations: { autoArchive: { enabled: true } },
      notifications: { newMessageEnabled: false },
    });
    expect(view.props.onOpenChange).not.toHaveBeenCalled();
  });

  test("reverting the draft disables Confirm", () => {
    const view = setup();
    const toggle = view.getByRole("switch", {
      name: "Chat reply alerts",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a remote refresh preserves the draft and its opening comparison", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    view.update({
      state: {
        status: "ready",
        values: {
          autoArchive: { enabled: false, afterDays: 30 },
          newMessageEnabled: false,
        },
      },
    });
    expect(
      view.getByRole("combobox", { name: "Time to Archive" }).textContent,
    ).toContain("7 days");
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledWith({
      conversations: { autoArchive: { enabled: true } },
    });
  });

  test("Cancel discards edits and reopening uses the latest saved values", async () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.props.onOpenChange).toHaveBeenCalledWith(false);
    expect(view.props.onSave).not.toHaveBeenCalled();
    view.update({ open: false });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    view.update({
      state: {
        status: "ready",
        values: {
          autoArchive: { enabled: true, afterDays: 14 },
          newMessageEnabled: false,
        },
      },
    });
    expect(
      view.getByRole("combobox", { name: "Time to Archive" }).textContent,
    ).toContain("14 days");
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test.each(["escape", "backdrop"])("%s dismissal never saves", (method) => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    if (method === "escape") {
      fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    } else {
      clickBackdrop();
    }
    expect(view.props.onOpenChange).toHaveBeenCalledWith(false);
    expect(view.props.onSave).not.toHaveBeenCalled();
  });

  test("pending save blocks duplicate submission and dismissal, then a failed save can retry", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    view.getByRole("button", { name: "Confirm" }).focus();
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    view.update({ saveStatus: "pending" });
    const savingButton = view.getByRole("button", { name: "Saving…" });
    expect(savingButton.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(savingButton);
    expect(
      view
        .getByRole("switch", { name: "Auto Archive Chats" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.submit(view.getByRole("dialog").querySelector("form")!);
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    clickBackdrop();
    expect(view.props.onSave).toHaveBeenCalledTimes(1);
    expect(view.props.onOpenChange).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toBe("Saving…");
    view.update({ saveStatus: "error" });
    expect(view.getByRole("alert").textContent).toContain(
      "Your changes are kept here",
    );
    expect(
      view
        .getByRole("switch", { name: "Auto Archive Chats" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledTimes(2);
  });

  test.each(["loading", "error", "unsupported"] as const)(
    "%s cannot submit guessed preferences",
    (status) => {
      const view = setup({ state: { status } });
      expect(view.queryByRole("switch")).toBeNull();
      expect(
        view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
      ).toBe(true);
      if (status === "error") {
        fireEvent.click(view.getByRole("button", { name: "Retry" }));
        expect(view.props.onRetryLoad).toHaveBeenCalledTimes(1);
      }
      expect(view.props.onSave).not.toHaveBeenCalled();
    },
  );

  test("finishing load initializes the form from the fetched values", () => {
    const view = setup({ state: { status: "loading" } });
    view.update({
      state: {
        status: "ready",
        values: {
          autoArchive: { enabled: true, afterDays: 1 },
          newMessageEnabled: false,
        },
      },
    });
    expect(
      view.getByRole("combobox", { name: "Time to Archive" }).textContent,
    ).toContain("1 day");
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("closing restores focus to the external settings button", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    try {
      const view = setup({ returnFocusRef: { current: button } });
      view.update({ open: false });
      await waitFor(() => expect(document.activeElement).toBe(button));
    } finally {
      button.remove();
    }
  });

  test("selecting a day through the nested portal keeps the modal open and preserves it when disabled", async () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    fireEvent.keyDown(view.getByRole("combobox", { name: "Time to Archive" }), {
      key: "ArrowDown",
    });
    const option = await view.findByRole("option", { name: "14 days" });
    fireEvent.click(option);
    await waitFor(() => expect(view.queryByRole("listbox")).toBeNull());
    expect(view.props.onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("switch", { name: "Auto Archive Chats" }));
    const select = view.getByRole("combobox", { name: "Time to Archive" });
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(select.textContent).toContain("14 days");
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledWith({
      conversations: { autoArchive: { afterDays: 14 } },
    });
  });
});
