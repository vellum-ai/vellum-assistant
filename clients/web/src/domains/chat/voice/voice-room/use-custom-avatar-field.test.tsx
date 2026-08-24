/**
 * The room's custom-avatar field color: async, cached, and never allowed to
 * throw. The color math itself is tested in `utils/avatar-image-color.test.ts`;
 * this covers the part the room depends on, which is that it always has an
 * answer to paint with.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const sampleSpy = mock(async (_src: string): Promise<string | null> => "#3B5C8A");
mock.module("@/utils/avatar-image-color", () => ({
  sampleAvatarFieldHex: sampleSpy,
}));

const { useCustomAvatarFieldHex, clearCustomAvatarFieldCache } = await import(
  "./use-custom-avatar-field"
);

function Probe({ url }: { url: string | null }) {
  const hex = useCustomAvatarFieldHex(url);
  return <div data-testid="field">{hex ?? "none"}</div>;
}

const field = () => screen.getByTestId("field").textContent;

beforeEach(() => {
  clearCustomAvatarFieldCache();
  sampleSpy.mockClear();
  sampleSpy.mockImplementation(async () => "#3B5C8A");
});

afterEach(() => {
  cleanup();
});

describe("useCustomAvatarFieldHex", () => {
  test("paints nothing until the sample lands", async () => {
    render(<Probe url="blob:avatar-1" />);
    // The first commit is what the room paints its first frame from, so the
    // decode must not be on that path.
    expect(field()).toBe("none");
    await waitFor(() => expect(field()).toBe("#3B5C8A"));
  });

  test("skips the work entirely without a custom image", () => {
    render(<Probe url={null} />);
    expect(field()).toBe("none");
    expect(sampleSpy).not.toHaveBeenCalled();
  });

  test("decodes each image once per session", async () => {
    render(<Probe url="blob:avatar-1" />);
    await waitFor(() => expect(field()).toBe("#3B5C8A"));
    cleanup();
    render(<Probe url="blob:avatar-1" />);
    // Cached, so re-entering the room paints on the first commit rather than
    // flashing the void again while the same image re-decodes.
    expect(field()).toBe("#3B5C8A");
    expect(sampleSpy).toHaveBeenCalledTimes(1);
  });

  test("does not retry an image it already failed to read", async () => {
    sampleSpy.mockImplementation(async () => null);
    render(<Probe url="blob:broken" />);
    await waitFor(() => expect(sampleSpy).toHaveBeenCalledTimes(1));
    cleanup();
    render(<Probe url="blob:broken" />);
    expect(field()).toBe("none");
    expect(sampleSpy).toHaveBeenCalledTimes(1);
  });

  test("re-samples when the assistant's image changes", async () => {
    render(<Probe url="blob:avatar-1" />);
    await waitFor(() => expect(field()).toBe("#3B5C8A"));
    sampleSpy.mockImplementation(async () => "#7A4C2F");
    cleanup();
    render(<Probe url="blob:avatar-2" />);
    await waitFor(() => expect(field()).toBe("#7A4C2F"));
  });

  test("drops the old color the moment the image is replaced", async () => {
    // Replacing an assistant's avatar swaps the URL under a mounted hook. The
    // room, the composer bar and the pill would otherwise keep painting the
    // previous avatar's color for as long as the new decode takes.
    let resolveSecond: ((hex: string | null) => void) | undefined;
    const { rerender } = render(<Probe url="blob:avatar-1" />);
    await waitFor(() => expect(field()).toBe("#3B5C8A"));
    sampleSpy.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    rerender(<Probe url="blob:avatar-2" />);
    expect(field()).toBe("none");
    await act(async () => {
      resolveSecond?.("#7A4C2F");
    });
    expect(field()).toBe("#7A4C2F");
  });
});
