/**
 * Tests for `useCopyToClipboard`'s lifecycle:
 *
 *   1. A write that resolves after unmount does no work. The clipboard promise
 *      resolves on its own schedule, and the effect cleanup has already run by
 *      then, so anything scheduled from the resolution outlives the component.
 *   2. A write that resolves while mounted still runs its caller's callback.
 *
 * The failure this guards is quiet: React does not warn on a setState after
 * unmount, so the leak is a timer nothing will clear rather than an error
 * anyone would see.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

import * as toastModule from "@vellumai/design-library/components/toast";

mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: { ...toastModule.toast, success: () => {}, error: () => {} },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useCopyToClipboard } = await import("@/hooks/use-copy-to-clipboard");

let resolveWrite: (() => void) | null = null;

beforeEach(() => {
  resolveWrite = null;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    },
  });
});

afterEach(cleanup);

function Harness({ onCopied }: { onCopied: () => void }) {
  const { copy, copied } = useCopyToClipboard({ errorMessage: "nope" });
  return (
    <button type="button" onClick={() => copy("payload", onCopied)}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

describe("useCopyToClipboard", () => {
  test("does no work when the write resolves after unmount", async () => {
    const calls: string[] = [];
    const { getByRole, unmount } = render(
      <Harness onCopied={() => calls.push("copied")} />,
    );

    getByRole("button").click();
    unmount();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    // Reaching the callback means the transient flag was set and a reset timer
    // armed, both after the cleanup that was supposed to have ended this.
    expect(calls).toEqual([]);
  });

  test("runs the caller's callback when the write resolves while mounted", async () => {
    const calls: string[] = [];
    const { getByRole } = render(
      <Harness onCopied={() => calls.push("copied")} />,
    );

    getByRole("button").click();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(calls).toEqual(["copied"]);
    expect(getByRole("button").textContent).toBe("Copied!");
  });
});
