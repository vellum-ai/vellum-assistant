import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";

import { useViewportMinHeight } from "@/domains/chat/transcript/use-viewport-min-height";
import {
  stubContentHeight,
  stubResizeObserver,
} from "@/hooks/overflow.test-helper";

const heights = new WeakMap<Element, number>();
let resizeObserver: ReturnType<typeof stubResizeObserver>;
let restoreHeights: () => void;

function resize(el: HTMLElement, height: number) {
  heights.set(el, height);
  act(() => resizeObserver.resize(el));
}

/** Keys its scroll container on the conversation, as `Transcript` does. */
function Harness({ conversationId }: { conversationId: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const minHeight = useViewportMinHeight(scrollRef, conversationId);
  return (
    <div key={conversationId} ref={scrollRef} data-testid="scroll">
      {minHeight}
    </div>
  );
}

beforeEach(() => {
  resizeObserver = stubResizeObserver();
  restoreHeights = stubContentHeight((el) => heights.get(el) ?? 600);
});

afterEach(() => {
  cleanup();
  restoreHeights();
  resizeObserver.restore();
});

describe("useViewportMinHeight", () => {
  test("follows the container through a resize", () => {
    const { getByTestId } = render(<Harness conversationId="conv-1" />);
    expect(getByTestId("scroll").textContent).toBe("600");

    resize(getByTestId("scroll"), 270);
    expect(getByTestId("scroll").textContent).toBe("270");
  });

  test("follows the new container once a draft resolves to its server id", () => {
    const { getByTestId, rerender } = render(
      <Harness conversationId="draft-1" />,
    );
    rerender(<Harness conversationId="conv-1" />);

    // The keyboard opening shrinks the replacement container.
    resize(getByTestId("scroll"), 270);
    expect(getByTestId("scroll").textContent).toBe("270");
  });
});
