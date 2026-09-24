/**
 * `useAsyncRead` sits between a source and the reply one read of it produces,
 * so these cases stay on the boundary between two sources: the render right
 * after the source changes, and a reply that lands once its source is no
 * longer the current one.
 *
 * The probe records every render rather than what the DOM ends up showing,
 * because a single stale frame is painted and then replaced.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { useAsyncRead } from "@/domains/chat/components/local-file/preview/use-async-read";

interface Frame {
  source: string;
  value: string | null;
  failed: boolean;
}

/** Every render the probe makes, in order. */
let frames: Frame[] = [];

/** What each source reads to, stated per case. */
let readers: Record<string, () => Promise<string>> = {};

/** A source no case gives a reader to stays in flight for good. */
function read(source: string): Promise<string> {
  const reader = readers[source];
  if (reader === undefined) {
    return new Promise<string>(() => {});
  }
  return reader();
}

function Probe({ source }: { source: string }): ReactNode {
  const { value, failed } = useAsyncRead(source, read);
  frames.push({ source, value, failed });
  return null;
}

function lastFrame(): Frame {
  return frames[frames.length - 1];
}

afterEach(() => {
  cleanup();
  frames = [];
  readers = {};
});

describe("useAsyncRead", () => {
  test("renders once on mount before the read resolves", () => {
    render(<Probe source="a" />);

    expect(frames).toEqual([{ source: "a", value: null, failed: false }]);
  });

  test("never hands a new source the previous source's value", async () => {
    readers = { a: () => Promise.resolve("A") };

    const { rerender } = render(<Probe source="a" />);
    await waitFor(() => expect(lastFrame().value).toBe("A"));

    rerender(<Probe source="b" />);

    expect(frames.some((f) => f.source === "b" && f.value === "A")).toBe(false);
    expect(lastFrame()).toEqual({ source: "b", value: null, failed: false });
  });

  test("drops a reply that lands after the source changed", async () => {
    let resolveA: (value: string) => void = () => {};
    readers = {
      a: () =>
        new Promise<string>((resolve) => {
          resolveA = resolve;
        }),
      b: () => Promise.resolve("B"),
    };

    const { rerender } = render(<Probe source="a" />);
    rerender(<Probe source="b" />);
    await waitFor(() => expect(lastFrame().value).toBe("B"));

    await act(async () => {
      resolveA("A");
    });

    expect(frames.some((f) => f.value === "A")).toBe(false);
    expect(lastFrame()).toEqual({ source: "b", value: "B", failed: false });
  });

  test("reports a rejected read as failed for its own source only", async () => {
    readers = { a: () => Promise.reject(new Error("read failed")) };

    const { rerender } = render(<Probe source="a" />);
    await waitFor(() => expect(lastFrame().failed).toBe(true));

    const firstFrameOfB = frames.length;
    rerender(<Probe source="b" />);

    expect(frames[firstFrameOfB]).toEqual({
      source: "b",
      value: null,
      failed: false,
    });
  });
});
