import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";

import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";
import { openDetailSheetFromTrigger } from "@/domains/chat/utils/open-detail-sheet-from-trigger";
import { MobileDetailSheet } from "./mobile-detail-sheet";

afterEach(cleanup);

function Example({ onClose = () => undefined }: { onClose?: () => void }) {
  const [data, setData] = useState<string | null>(null);
  return (
    <div data-slot="chat-body" tabIndex={-1}>
      <button
        onClick={(event) =>
          openDetailSheetFromTrigger(event, () => setData("Tool output"))
        }
      >
        Open details
      </button>
      <MobileDetailSheet
        data={data}
        onClose={() => {
          onClose();
          setData(null);
        }}
      >
        {(value) => (
          <div>
            <p>{value}</p>
            <button onClick={() => setData(null)}>Close details</button>
          </div>
        )}
      </MobileDetailSheet>
    </div>
  );
}

describe("MobileDetailSheet", () => {
  test("focuses the sheet and restores the tapped row without changing scroll", async () => {
    const { container } = render(<Example />);
    const conversation = container.firstElementChild as HTMLElement;
    conversation.scrollTop = 320;
    const trigger = screen.getByRole("button", { name: "Open details" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Activity details",
    });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(conversation.scrollTop).toBe(320);
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(0);
  });

  test("uses the supplied portal host and closes once on backdrop tap", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onClose = mock(() => undefined);
    render(
      <PortalContainerProvider container={host}>
        <Example onClose={onClose} />
      </PortalContainerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    const dialog = await screen.findByRole("dialog");
    expect(host.contains(dialog)).toBe(true);
    fireEvent.click(host.querySelector('[data-slot="bottom-sheet-overlay"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    host.remove();
  });

  test("returns focus to the conversation if its trigger disappears", async () => {
    const { container } = render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open details" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    trigger.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(container.firstElementChild),
    );
  });

  test("only handle drags dismiss, and cancelled or short drags keep it open", async () => {
    const onClose = mock(() => undefined);
    render(<Example onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    const dialog = await screen.findByRole("dialog");
    const handle = dialog.querySelector<HTMLElement>(
      '[data-slot="bottom-sheet-drag-handle"]',
    )!;
    handle.setPointerCapture = () => undefined;
    handle.hasPointerCapture = () => false;
    const pointer = {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    };
    const drag = (target: HTMLElement, distance: number, cancel = false) => {
      fireEvent.pointerDown(target, { ...pointer, clientY: 100 });
      fireEvent.pointerMove(target, { ...pointer, clientY: 100 + distance });
      if (cancel) {
        fireEvent.pointerCancel(target, pointer);
      } else {
        fireEvent.pointerUp(target, pointer);
      }
    };
    drag(screen.getByText("Tool output"), 200);
    drag(handle, 40);
    drag(handle, 150, true);
    expect(onClose).not.toHaveBeenCalled();
    drag(handle, 150);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("live output updates preserve the open sheet and its scroll container", async () => {
    const body = (value: string) => (
      <div data-testid="live-output">{value}</div>
    );
    const onClose = mock(() => undefined);
    const { rerender } = render(
      <MobileDetailSheet data="Running" onClose={onClose}>
        {body}
      </MobileDetailSheet>,
    );
    const dialog = await screen.findByRole("dialog");
    const output = screen.getByTestId("live-output");
    output.scrollTop = 160;
    rerender(
      <MobileDetailSheet data="Completed" onClose={onClose}>
        {body}
      </MobileDetailSheet>,
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByTestId("live-output")).toBe(output);
    expect(output.textContent).toBe("Completed");
    expect(output.scrollTop).toBe(160);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a new payload replaces the previous detail without a stale close", async () => {
    const onClose = mock(() => undefined);
    const body = (value: string) => <p>{value}</p>;
    const { rerender } = render(
      <MobileDetailSheet data="First" onClose={onClose}>
        {body}
      </MobileDetailSheet>,
    );
    await screen.findByText("First");
    rerender(
      <MobileDetailSheet data={null} onClose={onClose}>
        {body}
      </MobileDetailSheet>,
    );
    rerender(
      <MobileDetailSheet data="Second" onClose={onClose}>
        {body}
      </MobileDetailSheet>,
    );
    expect(await screen.findByText("Second")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
