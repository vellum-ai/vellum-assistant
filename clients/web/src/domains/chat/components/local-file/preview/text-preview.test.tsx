import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TextPreview } from "@/domains/chat/components/local-file/preview/text-preview";

/** The cap the preview lays out, mirrored here so the boundary is explicit. */
const CAP = 2 * 1024 * 1024;

afterEach(() => {
  cleanup();
});

describe("TextPreview", () => {
  test("renders the bytes verbatim in a monospace block", async () => {
    const { container } = render(
      <TextPreview
        blob={new Blob(["line one\nline two"])}
        filename="notes.log"
      />,
    );

    await waitFor(() => expect(screen.getByText(/line one/)).toBeTruthy());
    expect(container.querySelector("pre")?.textContent).toBe(
      "line one\nline two",
    );
  });

  test("a file past the cap says it was truncated", async () => {
    render(
      <TextPreview
        blob={new Blob(["a".repeat(CAP + 1)])}
        filename="big.log"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Showing the first 2 MB")).toBeTruthy(),
    );
  });

  test("a file under the cap carries no truncation notice", async () => {
    render(<TextPreview blob={new Blob(["short"])} filename="short.txt" />);

    await waitFor(() => expect(screen.getByText("short")).toBeTruthy());
    expect(screen.queryByText("Showing the first 2 MB")).toBeNull();
  });
});
