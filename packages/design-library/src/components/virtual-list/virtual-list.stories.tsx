import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { GoToNewest } from "./go-to-newest";
import { VirtualList, type VirtualListHandle } from "./virtual-list";

const meta: Meta<typeof VirtualList> = {
  title: "Components/VirtualList/VirtualList",
  component: VirtualList,
  parameters: { layout: "centered" },
};

export default meta;

type Story = StoryObj<typeof VirtualList>;

/** Fixed-size scroll frame — `Virtuoso` fills its sized parent (`h-full`). */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: 480,
        width: 360,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
      }}
    >
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border-base)] px-4 py-3 text-body-medium-default text-[color:var(--content-default)]">
      {children}
    </div>
  );
}

const ROWS = Array.from({ length: 1000 }, (_, i) => `Row ${i + 1}`);

/** 1,000 rows — only the visible window is in the DOM. */
export const Default: Story = {
  render: () => (
    <Frame>
      <VirtualList<string>
        className="h-full"
        items={ROWS}
        computeItemKey={(_index, item) => item}
        itemContent={(_index, item) => <Row>{item}</Row>}
      />
    </Frame>
  ),
};

/** Streaming transcript: new rows append on an interval. The list follows the
 *  bottom only while the user is already there; scroll up and a `GoToNewest`
 *  pill appears to jump back. */
export const StreamingWithGoToNewest: Story = {
  render: function StreamingStory() {
    const [items, setItems] = useState(() =>
      Array.from({ length: 25 }, (_, i) => `Message ${i + 1}`),
    );
    const [atBottom, setAtBottom] = useState(true);
    const ref = useRef<VirtualListHandle>(null);

    useEffect(() => {
      const id = setInterval(() => {
        setItems((prev) => [...prev, `Message ${prev.length + 1}`]);
      }, 1500);
      return () => clearInterval(id);
    }, []);

    return (
      <Frame>
        <div style={{ position: "relative", height: "100%" }}>
          <VirtualList<string>
            ref={ref}
            className="h-full"
            items={items}
            followOutput="smooth"
            atBottomStateChange={setAtBottom}
            computeItemKey={(_index, item) => item}
            itemContent={(_index, item) => <Row>{item}</Row>}
          />
          <div
            style={{
              position: "absolute",
              bottom: 12,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <GoToNewest
              visible={!atBottom}
              isStreaming
              onClick={() => ref.current?.scrollToBottom({ behavior: "smooth" })}
            />
          </div>
        </div>
      </Frame>
    );
  },
};
