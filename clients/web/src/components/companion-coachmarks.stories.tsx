/**
 * The marks as the frame window actually draws them.
 *
 * **The lab beside this one draws paths; this draws the component.** Between
 * the two sits everything that can go wrong without either the shapes or the
 * component being wrong: where a mark is placed against the window, which
 * side its caption hangs from, whether a turned arrow still lands its tip on
 * the point, and whether the CSS carries the accent and the halo. None of
 * that is visible in a path, and all of it is what a person on a call sees.
 *
 * The marks are fractions of the window, and the window here is the iframe,
 * so a mark at 0.5 sits at the middle of whatever this is rendered in.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { CompanionCoachmarks } from "@/components/companion-coachmarks";
import type { CompanionCoachmark } from "@vellumai/ipc-contract";

/** The screens a mark has to stay found on, as the lab uses them. */
const BACKDROPS = {
  document: "#ffffff",
  editor: "#1e1f22",
  photograph:
    "linear-gradient(115deg,#6a7f5e 0%,#c8b48a 34%,#3f4a58 68%,#8a6f52 100%)",
} as const;

type Backdrop = keyof typeof BACKDROPS;

/** The accent an assistant carries. */
const INK = "#e0703a";

/**
 * A stand-in for the control being pointed at, placed by the same fractions
 * the mark is, so what is drawn is judged against what it is drawn around.
 */
function Control({
  x,
  y,
  width,
  height,
  label,
  dark,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  dark: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
        borderRadius: 7,
        display: "grid",
        placeItems: "center",
        fontSize: 14,
        color: dark ? "#e8e8e8" : "#3c3c3c",
        background: dark ? "#3a3d42" : "#e6e6e6",
      }}
    >
      {label}
    </div>
  );
}

interface Args {
  backdrop: Backdrop;
}

const meta: Meta<Args> = {
  title: "Companion/Coachmarks",
  parameters: { layout: "fullscreen" },
  argTypes: {
    backdrop: {
      control: "inline-radio",
      options: ["document", "editor", "photograph"],
    },
  },
  args: { backdrop: "editor" },
};

export default meta;
type Story = StoryObj<Args>;

/** The surface the frame window is, with the marks drawn on it. */
function Frame({
  backdrop,
  marks,
  controls,
}: {
  backdrop: Backdrop;
  marks: readonly CompanionCoachmark[];
  controls: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        height: "100vh",
        background: BACKDROPS[backdrop],
        overflow: "hidden",
      }}
    >
      {controls}
      <CompanionCoachmarks marks={marks} ink={INK} />
    </div>
  );
}

/**
 * One of each, with the captions that go with them.
 *
 * A loop says "this thing", an arrow says "that place". Side by side because
 * the two have to read as one hand: they are drawn by the same assistant in
 * the same conversation, often one after the other.
 */
export const BothMarks: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    return (
      <Frame
        backdrop={args.backdrop}
        marks={[
          {
            kind: "region",
            x: 0.16,
            y: 0.34,
            width: 0.1,
            height: 0.08,
            caption: "Open colour balance",
          },
          { kind: "point", x: 0.62, y: 0.36, caption: "Click Share" },
        ]}
        controls={
          <>
            <Control
              x={0.16}
              y={0.34}
              width={0.1}
              height={0.08}
              label="◐ Colour"
              dark={dark}
            />
            <Control
              x={0.58}
              y={0.335}
              width={0.08}
              height={0.05}
              label="Share"
              dark={dark}
            />
          </>
        }
      />
    );
  },
};

/**
 * A point with the room above it rather than below.
 *
 * The arrow turns over so its tail stays on the caption's side, and the tip
 * has to come back to the same place: a turned arrow that lands short is the
 * bug this story is for.
 *
 * The controls are drawn centred on their points, because that is what the
 * host sends for a named target: the element's centre, never its frame. It is
 * also what makes the tip's ten-pixel standoff land inside anything taller
 * than about twenty pixels, which is visible here and is a property of the
 * point contract rather than of the hand.
 */
export const ArrowTurnedOver: Story = {
  render: (args) => (
    <Frame
      backdrop={args.backdrop}
      marks={[
        { kind: "point", x: 0.3, y: 0.9, caption: "Press this" },
        { kind: "point", x: 0.7, y: 0.12, caption: "Then this" },
      ]}
      controls={
        <>
          <Control
            x={0.27}
            y={0.88}
            width={0.06}
            height={0.04}
            label="A"
            dark={args.backdrop !== "document"}
          />
          <Control
            x={0.67}
            y={0.1}
            width={0.06}
            height={0.04}
            label="B"
            dark={args.backdrop !== "document"}
          />
        </>
      }
    />
  ),
};

/**
 * The same anchors drawn twice over, and a row of different ones.
 *
 * The hand is seeded off where the mark is, so a control pointed at twice in
 * a conversation is looped the same way both times, while two different
 * controls are not. Variety within a voice, rather than a stamp or a scrawl.
 */
export const HandVariety: Story = {
  render: (args) => (
    <Frame
      backdrop={args.backdrop}
      marks={Array.from({ length: 5 }, (_, i) => ({
        kind: "region" as const,
        x: 0.08 + i * 0.17,
        y: 0.4,
        width: 0.07,
        height: 0.07,
      }))}
      controls={Array.from({ length: 5 }, (_, i) => (
        <Control
          key={i}
          x={0.08 + i * 0.17}
          y={0.4}
          width={0.07}
          height={0.07}
          label={`${i + 1}`}
          dark={args.backdrop !== "document"}
        />
      ))}
    />
  ),
};
