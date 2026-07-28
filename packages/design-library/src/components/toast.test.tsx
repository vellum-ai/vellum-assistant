/**
 * Tests for the toast wrapper around sonner.
 *
 * No DOM environment — sonner's imperative state (`ToastState`) works without
 * one, so we verify the id contract directly against `sonnerToast.getHistory()`.
 *
 * Regression guard: sonner spreads caller options over its generated id
 * (`{ jsx: jsx(id), id, ...data }`), so passing an explicit `id: undefined`
 * key detaches the stored toast's id from the id given to the jsx callback
 * and returned to the caller — dismissing (the X button) then no-ops.
 */

import { describe, expect, test } from "bun:test";
import { toast as sonnerToast } from "sonner";

import { toast } from "./toast";

// sonner's dismiss() notifies subscribers via requestAnimationFrame, which
// this DOM-less environment doesn't provide.
globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0) as unknown as number;

function storedToast(id: string | number) {
  return sonnerToast.getHistory().find((t) => t.id === id);
}

describe("toast id contract", () => {
  test("variant toast without an explicit id stores the toast under the returned id", () => {
    const id = toast.success("Update complete — assistant is healthy.");
    expect(storedToast(id)).toBeDefined();
  });

  test("variant toast with an explicit id keeps that id", () => {
    const id = toast.info("hello", { id: "my-toast" });
    expect(id).toBe("my-toast");
    expect(storedToast("my-toast")).toBeDefined();
  });

  test("custom toast without an explicit id stores the toast under the id given to the render callback", () => {
    let renderedWithId: string | number | undefined;
    const id = toast.custom((toastId) => {
      renderedWithId = toastId;
      return <div />;
    });
    expect(renderedWithId).toBe(id);
    expect(storedToast(id)).toBeDefined();
  });

  test("dismissing by the returned id marks the toast dismissed", () => {
    const id = toast.warning("something");
    expect(sonnerToast.getToasts().some((t) => t.id === id)).toBe(true);
    toast.dismiss(id);
    expect(sonnerToast.getToasts().some((t) => t.id === id)).toBe(false);
  });
});
