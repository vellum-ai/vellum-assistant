/**
 * Tests for `useCopyToClipboard`'s lifecycle:
 *
 *   1. A write that resolves after unmount does no work. The clipboard promise
 *      resolves on its own schedule, and the effect cleanup has already run by
 *      then, so anything scheduled from the resolution outlives the component.
 *   2. A write that resolves while mounted still runs its caller's callback.
 *   3. `reset` clears the flag at once, for a surface dismissed before the
 *      flag would have cleared on its own.
 *   4. A `successMessage` reaches the success toast.
 *
 * The failure this guards is quiet: React does not warn on a setState after
 * unmount, so the leak is a timer nothing will clear rather than an error
 * anyone would see.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

import * as toastModule from "@vellumai/design-library/components/toast";

const successToasts: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    ...toastModule.toast,
    success: (message: string) => {
      successToasts.push(message);
    },
    error: () => {},
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { useCopyToClipboard } = await import("@/hooks/use-copy-to-clipboard");

let resolveWrite: (() => void) | null = null;

beforeEach(() => {
  resolveWrite = null;
  successToasts.length = 0;
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

function Harness({
  onCopied,
  successMessage,
}: {
  onCopied: () => void;
  successMessage?: string;
}) {
  const { copy, copied, reset } = useCopyToClipboard({
    errorMessage: "nope",
    successMessage,
  });
  return (
    <>
      <button type="button" onClick={() => copy("payload", onCopied)}>
        {copied ? "Copied!" : "Copy"}
      </button>
      <button type="button" onClick={reset}>
        Reset
      </button>
    </>
  );
}

describe("useCopyToClipboard", () => {
  test("does no work when the write resolves after unmount", async () => {
    const calls: string[] = [];
    const { getByRole, unmount } = render(
      <Harness onCopied={() => calls.push("copied")} />,
    );

    getByRole("button", { name: "Copy" }).click();
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

    getByRole("button", { name: "Copy" }).click();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(calls).toEqual(["copied"]);
    expect(getByRole("button", { name: "Copied!" })).toBeDefined();
  });

  test("reset clears the copied flag before its timer would", async () => {
    const { getByRole, queryByRole } = render(<Harness onCopied={() => {}} />);

    getByRole("button", { name: "Copy" }).click();
    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });
    expect(getByRole("button", { name: "Copied!" })).toBeDefined();

    act(() => {
      getByRole("button", { name: "Reset" }).click();
    });

    expect(queryByRole("button", { name: "Copied!" })).toBeNull();
    expect(getByRole("button", { name: "Copy" })).toBeDefined();
  });

  test("shows the success toast when given one", async () => {
    const { getByRole } = render(
      <Harness onCopied={() => {}} successMessage="Link copied" />,
    );

    getByRole("button", { name: "Copy" }).click();
    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(successToasts).toEqual(["Link copied"]);
  });
});
