/**
 * The bench for the marks the assistant draws on a screen someone is sharing.
 *
 * **It exists because these are the only drawings in the product nobody can
 * see while building them.** A mark is placed on a frame window over another
 * app during a live call, so the ordinary way to look at one is to start a
 * call, share a screen and ask an assistant to point at something. That is a
 * long way to go to find out that a curve leans the wrong way.
 *
 * The two things worth judging here cannot be judged from a single example.
 * How much the hand wanders is a range, and the answer is somewhere between a
 * drafting machine and a scrawl over someone else's work: the strengths are
 * drawn side by side so the step between them is visible, with the settings
 * that were chosen marked. Legibility is a question about backgrounds rather
 * than about the mark, so every backdrop the accent has to survive is here
 * too, drawn with the same halo the product uses.
 *
 * The paths come from `companion-coachmark-shapes.ts`, which is given a place
 * and a side and works out the rest. Nothing in these stories passes a
 * coordinate that the assistant would be asked for.
 *
 * These draw paths. `companion-coachmarks.stories.tsx` draws the component
 * that places them, which is the other half of what a person on a call sees.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { seedFor } from "@/components/companion-coachmark-path";
import {
  arrowPath,
  enclosurePath,
  HAND_ARROW,
  HAND_ENCLOSURE,
  HAND_MAX,
  type Approach,
} from "@/components/companion-coachmark-shapes";

/**
 * The screens a mark has to stay found on.
 *
 * A white document and a dark editor are the two the halo exists for. The
 * photograph is the case neither of them covers: a busy mid-tone where a
 * stroke can disappear into detail rather than into a flat colour.
 */
const BACKDROPS = {
  document: "#ffffff",
  editor: "#1e1f22",
  photograph:
    "linear-gradient(115deg,#6a7f5e 0%,#c8b48a 34%,#3f4a58 68%,#8a6f52 100%)",
} as const;

type Backdrop = keyof typeof BACKDROPS;

/** The accent an assistant carries, which the marks are drawn in. */
const INK = "#e0703a";

/** The stroke and the halo under it, as the frame window draws them. */
const STROKE = 5;
const HALO = 9;

/**
 * A stand-in for the control being pointed at.
 *
 * Sized like the ones that turned up in practice: iMovie's colour balance is a
 * 37x31 pt hit area around a 17x18 pt glyph, and the glyph is what a person
 * sees. The box here is the glyph, so a loop drawn around it is judged against
 * what the user is looking at rather than against a rectangle only the
 * accessibility tree knows about.
 */
function Target({ label, dark }: { label: string; dark: boolean }) {
  return (
    <div
      style={{
        width: 34,
        height: 30,
        borderRadius: 7,
        display: "grid",
        placeItems: "center",
        fontSize: 15,
        color: dark ? "#e8e8e8" : "#3c3c3c",
        background: dark ? "#3a3d42" : "#e6e6e6",
      }}
    >
      {label}
    </div>
  );
}

/**
 * One mark over one target, drawn the way the frame window draws it: the halo
 * underneath and the accent on top, both from the same path, so a stroke reads
 * over whatever it lands on.
 */
function Mark({
  kind,
  strength,
  approach,
  seed,
  dark,
}: {
  kind: "arrow" | "enclosure";
  strength: number;
  approach: Approach;
  seed: number;
  dark: boolean;
}) {
  if (kind === "enclosure") {
    const box = { width: 34, height: 30 };
    const padding = 9;
    const room = padding + HALO;
    const size = {
      width: box.width + room * 2,
      height: box.height + room * 2,
    };
    const d = enclosurePath(box, { strength, seed, padding });
    return (
      <div
        style={{ position: "relative", display: "grid", placeItems: "center" }}
      >
        <Target label="◐" dark={dark} />
        <svg
          width={size.width}
          height={size.height}
          viewBox={`${-room} ${-room} ${size.width} ${size.height}`}
          style={{
            position: "absolute",
            overflow: "visible",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          <path
            d={d}
            fill="none"
            stroke="rgba(0,0,0,0.3)"
            strokeWidth={HALO}
            strokeLinecap="round"
          />
          <path
            d={d}
            fill="none"
            stroke={INK}
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }

  const arrow = arrowPath({ length: 52, approach, strength, seed });
  return (
    <div style={{ display: "grid", placeItems: "center", gap: 0 }}>
      {approach === "below" ? <Target label="▶" dark={dark} /> : null}
      <svg
        width={arrow.width}
        height={arrow.height}
        viewBox={`0 0 ${arrow.width} ${arrow.height}`}
        style={{
          overflow: "visible",
          transform: approach === "above" ? "rotate(180deg)" : undefined,
        }}
        aria-hidden="true"
      >
        {[
          { color: "rgba(0,0,0,0.3)", width: HALO },
          { color: INK, width: STROKE },
        ].map((pass) => (
          <g
            key={pass.color}
            fill="none"
            stroke={pass.color}
            strokeWidth={pass.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={arrow.shaft} />
            <path d={arrow.head} />
          </g>
        ))}
      </svg>
      {approach === "above" ? <Target label="▶" dark={dark} /> : null}
    </div>
  );
}

/** The label under a drawing. */
function Caption({ text, dark }: { text: string; dark: boolean }) {
  return (
    <code style={{ fontSize: 11, color: dark ? "#b9b9b9" : "#585858" }}>
      {text}
    </code>
  );
}

interface LabArgs {
  backdrop: Backdrop;
  approach: Approach;
  /** How many hands to draw across the range, so the step is visible. */
  steps: number;
}

const meta: Meta<LabArgs> = {
  title: "Companion/Coachmark lab",
  parameters: { layout: "fullscreen" },
  argTypes: {
    backdrop: {
      control: "inline-radio",
      options: ["document", "editor", "photograph"],
    },
    approach: { control: "inline-radio", options: ["below", "above"] },
    steps: { control: { type: "range", min: 3, max: 7, step: 1 } },
  },
  args: { backdrop: "editor", approach: "below", steps: 5 },
};

export default meta;
type Story = StoryObj<LabArgs>;

/**
 * The range of hands, on one backdrop.
 *
 * Read left to right and stop where it stops looking deliberate. The leftmost
 * is a machine and the rightmost is past what should ever ship; the answer is
 * one of the ones in between, and it is not obvious which without seeing them
 * together.
 *
 * The loop and the arrow are drawn at the same setting in each column, which
 * is what the two chosen numbers came from: a shaft shows deviation more than
 * a closed loop does, so the arrow reaches the point where it stops looking
 * deliberate before the loop reaches it.
 */
export const HandStrength: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    const strengths = Array.from(
      { length: args.steps },
      (_, i) => (HAND_MAX * i) / (args.steps - 1),
    );
    return (
      <div
        style={{
          background: BACKDROPS[args.backdrop],
          padding: 48,
          minHeight: 520,
        }}
      >
        <div style={{ display: "flex", gap: 56, alignItems: "flex-start" }}>
          {strengths.map((strength, i) => (
            <div
              key={strength}
              style={{ display: "grid", gap: 40, justifyItems: "center" }}
            >
              <Mark
                kind="enclosure"
                strength={strength}
                approach={args.approach}
                seed={seedFor(0.3 + i / 10, 0.4)}
                dark={dark}
              />
              <Mark
                kind="arrow"
                strength={strength}
                approach={args.approach}
                seed={seedFor(0.3 + i / 10, 0.4)}
                dark={dark}
              />
              <Caption text={strength.toFixed(3)} dark={dark} />
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/**
 * The two settings that were chosen, beside each other.
 *
 * Not a range: this is what ships. The loop wanders further than the arrow on
 * purpose, and seeing them together is the check that the difference reads as
 * one hand rather than as two.
 */
export const Chosen: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    return (
      <div
        style={{
          background: BACKDROPS[args.backdrop],
          padding: 48,
          display: "flex",
          gap: 64,
          alignItems: "flex-start",
        }}
      >
        <div style={{ display: "grid", gap: 20, justifyItems: "center" }}>
          <Mark
            kind="enclosure"
            strength={HAND_ENCLOSURE}
            approach={args.approach}
            seed={seedFor(0.42, 0.42)}
            dark={dark}
          />
          <Caption text={`loop ${HAND_ENCLOSURE}`} dark={dark} />
        </div>
        <div style={{ display: "grid", gap: 20, justifyItems: "center" }}>
          <Mark
            kind="arrow"
            strength={HAND_ARROW}
            approach={args.approach}
            seed={seedFor(0.42, 0.42)}
            dark={dark}
          />
          <Caption text={`arrow ${HAND_ARROW}`} dark={dark} />
        </div>
      </div>
    );
  },
};

/**
 * The chosen hand, on every backdrop at once.
 *
 * The halo is the whole reason this story exists: an accent that reads on an
 * editor can vanish on a photograph, and the only way to know is to put them
 * beside each other.
 */
export const Legibility: Story = {
  render: (args) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        minHeight: 420,
      }}
    >
      {(Object.keys(BACKDROPS) as Backdrop[]).map((backdrop) => (
        <div
          key={backdrop}
          style={{
            background: BACKDROPS[backdrop],
            padding: 40,
            display: "grid",
            gap: 36,
            justifyItems: "center",
          }}
        >
          <Mark
            kind="enclosure"
            strength={HAND_ENCLOSURE}
            approach={args.approach}
            seed={seedFor(0.5, 0.5)}
            dark={backdrop !== "document"}
          />
          <Mark
            kind="arrow"
            strength={HAND_ARROW}
            approach={args.approach}
            seed={seedFor(0.5, 0.5)}
            dark={backdrop !== "document"}
          />
          <Caption text={backdrop} dark={backdrop !== "document"} />
        </div>
      ))}
    </div>
  ),
};

/**
 * The same mark drawn many times.
 *
 * Every one of these is a different anchor, so this is what a conversation
 * looks like when the assistant points at several things in turn. A hand that
 * is charming once and identical eight times reads as a stamp; one that is
 * different every time reads as noise. What is wanted is variety that stays
 * within a voice.
 */
export const Variety: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    return (
      <div
        style={{
          background: BACKDROPS[args.backdrop],
          padding: 48,
          minHeight: 460,
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 44 }}>
          {Array.from({ length: 8 }, (_, i) => (
            <Mark
              key={i}
              kind={i % 2 === 0 ? "enclosure" : "arrow"}
              strength={i % 2 === 0 ? HAND_ENCLOSURE : HAND_ARROW}
              approach={args.approach}
              seed={seedFor(0.1 * i, 0.2 + i / 40)}
              dark={dark}
            />
          ))}
        </div>
      </div>
    );
  },
};

/**
 * One anchor, drawn twice.
 *
 * The pair has to be identical. An assistant pointing at the same control
 * again in the same conversation must not redraw it differently, or the mark
 * reads as a new instruction rather than the same one.
 */
export const Deterministic: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    const seed = seedFor(0.42, 0.42);
    return (
      <div
        style={{
          background: BACKDROPS[args.backdrop],
          padding: 48,
          display: "flex",
          gap: 72,
        }}
      >
        {["first", "second"].map((which) => (
          <div
            key={which}
            style={{ display: "grid", gap: 36, justifyItems: "center" }}
          >
            <Mark
              kind="enclosure"
              strength={HAND_ENCLOSURE}
              approach={args.approach}
              seed={seed}
              dark={dark}
            />
            <Mark
              kind="arrow"
              strength={HAND_ARROW}
              approach={args.approach}
              seed={seed}
              dark={dark}
            />
            <Caption text={which} dark={dark} />
          </div>
        ))}
      </div>
    );
  },
};
