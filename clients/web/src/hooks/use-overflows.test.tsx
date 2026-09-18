import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { stubOverflow } from "@/hooks/overflow.test-helper";
import { useOverflows } from "@/hooks/use-overflows";

function Probe({ text, paused = false }: { text: string; paused?: boolean }) {
  const { ref, overflows } = useOverflows<HTMLDivElement>({
    contentKey: text,
    paused,
  });
  return (
    <>
      <div ref={ref}>{text}</div>
      <span>{overflows ? "overflows" : "fits"}</span>
    </>
  );
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

describe("useOverflows", () => {
  test("reports overflow only when the content is taller than the element", () => {
    restore = stubOverflow((el) => el.textContent === "tall");
    const { getByText, rerender } = render(<Probe text="short" />);
    expect(getByText("fits")).toBeDefined();

    rerender(<Probe text="tall" />);
    expect(getByText("overflows")).toBeDefined();
  });

  test("holds the last measurement while paused", () => {
    restore = stubOverflow((el) => el.textContent === "tall");
    const { getByText, rerender } = render(<Probe text="tall" />);
    expect(getByText("overflows")).toBeDefined();

    // Paused, a change that would now fit is not measured.
    rerender(<Probe text="short" paused />);
    expect(getByText("overflows")).toBeDefined();

    rerender(<Probe text="short" />);
    expect(getByText("fits")).toBeDefined();
  });
});
