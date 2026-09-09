/**
 * The bench for the marks the assistant draws on a screen someone is sharing.
 *
 * **It exists because these are the only drawings in the product nobody can
 * see while building them.** A mark is placed on a frame window over another
 * app during a live call, so the ordinary way to look at one is to start a
 * call, share a screen and ask an assistant to point at something. That is a
 * long way to go to find out that a curve leans the wrong way.
 *
 * The three things worth judging here cannot be judged from a single example.
 * Which voice a mark is drawn in is a choice between a hand and a machine that
 * is listening, and the machine-drawn ones are built from the voice room's
 * mesh, so they are here beside the hand rather than described. How much the
 * hand wanders is a range, and the answer is somewhere between a drafting
 * machine and a scrawl over someone else's work: the strengths are drawn side
 * by side so the step between them is visible. Legibility is a question about
 * backgrounds rather than about the mark, so every backdrop the accent has to
 * survive is here too, drawn with the same halo the product uses.
 *
 * The paths come from `companion-coachmark-shapes.ts`, which is given a place
 * and a side and works out the rest. Nothing in these stories passes a
 * coordinate that the assistant would be asked for.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { seedFor } from "@/components/companion-coachmark-path";
import {
  HAND_ARROW,
  HAND_ENCLOSURE,
  HAND_MAX,
  type Approach,
} from "@/components/companion-coachmark-shapes";
import {
  arrowStrokes,
  enclosureStrokes,
  MARK_FAMILIES,
  MARK_STYLES,
  type MarkStyle,
} from "@/components/companion-coachmark-lab-styles";

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
 * How a style is laid down on a screen that belongs to something else.
 *
 * Every mark gets the dark halo, which is what keeps an accent legible over a
 * photograph. The machine-drawn ones get a wide, faint pass of the accent
 * under the crisp one as well: the voice room's mesh has no blur anywhere in
 * it and gets its glow from strokes piling onto each other, and a static mark
 * has to fake that with one soft pass because it has no frames to add up.
 */
const GLOWS: Record<MarkStyle, boolean> = {
  hand: false,
  filament: true,
  weave: true,
  ribbon: true,
  comb: true,
  waveform: true,
  reticle: true,
  caliper: true,
  scanline: true,
  crosshair: true,
  pulse: true,
};

/**
 * How thick a style's full-weight stroke is.
 *
 * A pen line and a sheet of filaments cannot be the same width. One stroke has
 * to carry the whole mark, so it is drawn at the weight a marker has; a style
 * that lays down nine curves reads as light rather than as a blob only if each
 * of them is a hairline, and the mark's presence comes from how many there are
 * instead.
 */
const STROKES: Record<MarkStyle, number> = {
  hand: 5,
  filament: 2.6,
  weave: 2.4,
  ribbon: 3,
  comb: 3,
  waveform: 3.2,
  reticle: 3.4,
  caliper: 3,
  scanline: 3.2,
  crosshair: 3.2,
  pulse: 3.4,
};

/**
 * One mark over one target, drawn the way the frame window draws it: the halo
 * underneath and the accent on top, both from the same paths, so a stroke
 * reads over whatever it lands on.
 *
 * Every style comes back as a list of passes rather than as one path, so this
 * draws a hand-drawn loop and a nine-filament sheet with the same code. What a
 * style decides is `weight` and `alpha`; how thick a mark is at all is decided
 * here, once.
 */
function Mark({
  kind,
  style,
  strength,
  approach,
  seed,
  dark,
}: {
  kind: "arrow" | "enclosure";
  style: MarkStyle;
  strength: number;
  approach: Approach;
  seed: number;
  dark: boolean;
}) {
  const stroke = STROKES[style];
  const glow = GLOWS[style];

  /**
   * The three passes of one path: halo, accent glow, accent.
   *
   * The halo is an outline around whatever the ink is rather than a multiple
   * of it. A fixed width would put a 4px black stroke under a 1px filament,
   * and nine of those merge into one dark blob with the drawing lost inside
   * it: the sheet would be legible and unreadable at the same time.
   */
  const passes = (d: string, weight: number, alpha: number, i: number) => {
    const ink = stroke * weight;
    return (
      <g key={i} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          d={d}
          stroke="rgba(0,0,0,0.34)"
          strokeWidth={ink + 3.2}
          // Lighter under a hairline than under a full stroke. A sheet is
          // nine halos over the same small area, and at full strength they
          // stack into a dark mass that reads as a smudge on a white page.
          strokeOpacity={alpha * (0.5 + weight * 0.5)}
        />
        {glow ? (
          <path
            d={d}
            stroke={INK}
            strokeWidth={ink * 4.5}
            strokeOpacity={alpha * 0.1}
          />
        ) : null}
        <path d={d} stroke={INK} strokeWidth={ink} strokeOpacity={alpha} />
      </g>
    );
  };

  if (kind === "enclosure") {
    const box = { width: 34, height: 30 };
    const padding = 9;
    // Room for whatever stands furthest out: a ping's last ring travels well
    // past the loop the other styles draw, and a clipped mark is not a mark.
    const room = padding + 30;
    const size = { width: box.width + room * 2, height: box.height + room * 2 };
    const strokes = enclosureStrokes(style, box, { strength, seed, padding });
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
          {strokes.map((pass, i) => passes(pass.d, pass.weight, pass.alpha, i))}
        </svg>
      </div>
    );
  }

  const arrow = arrowStrokes(style, { length: 52, approach, strength, seed });
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
        {arrow.strokes.map((pass, i) =>
          passes(pass.d, pass.weight, pass.alpha, i),
        )}
      </svg>
      {approach === "above" ? <Target label="▶" dark={dark} /> : null}
    </div>
  );
}

/** A style's name under the drawing, since none of them are self-evident. */
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
  /** Which voice to draw the single-style stories in. */
  style: MarkStyle;
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
    style: { control: "inline-radio", options: MARK_STYLES },
    steps: { control: { type: "range", min: 3, max: 7, step: 1 } },
  },
  args: { backdrop: "editor", approach: "below", style: "hand", steps: 5 },
};

export default meta;
type Story = StoryObj<LabArgs>;

/**
 * Every voice, grouped by what it is doing.
 *
 * **This is the story the decision gets made in.** `hand` is the companion
 * writing on the screen. The **woven** row is the voice room's mesh: hairline
 * curves phase shifted through one another, bright only where they cross,
 * with no blur anywhere. The **instrument** row does not draw a shape around
 * the control at all, it holds it, and nothing in that row crosses the thing
 * being pointed at except one deliberate pass.
 *
 * What to look for, in order: whether the thing being pointed at is still
 * readable through the mark, whether the mark reads at a glance from across a
 * desk, and whether it looks like the assistant did it or like an app crashed.
 */
export const Styles: Story = {
  render: (args) => {
    const dark = args.backdrop !== "document";
    return (
      <div
        style={{
          background: BACKDROPS[args.backdrop],
          padding: 40,
          display: "grid",
          gap: 34,
        }}
      >
        {MARK_FAMILIES.map((family) => (
          <div key={family.name} style={{ display: "grid", gap: 14 }}>
            <Caption text={family.name} dark={dark} />
            <div
              style={{
                display: "flex",
                gap: 46,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              {family.styles.map((style, i) => (
                <div
                  key={style}
                  style={{ display: "grid", gap: 40, justifyItems: "center" }}
                >
                  <Mark
                    kind="enclosure"
                    style={style}
                    strength={HAND_ENCLOSURE}
                    approach={args.approach}
                    seed={seedFor(0.2 + i / 9, 0.35)}
                    dark={dark}
                  />
                  <Mark
                    kind="arrow"
                    style={style}
                    strength={HAND_ARROW}
                    approach={args.approach}
                    seed={seedFor(0.2 + i / 9, 0.35)}
                    dark={dark}
                  />
                  <Caption text={style} dark={dark} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  },
};

/**
 * Every voice over every backdrop.
 *
 * The glow the machine-drawn styles carry is the thing this story is for. It
 * is what makes a filament bundle read as light rather than as a smudge, and
 * it is also the first thing to disappear over a photograph, where the accent
 * has a busy mid-tone to compete with rather than a flat colour. A style that
 * only holds up on the dark editor is not a style, it is a screenshot.
 */
export const StylesOnEveryBackdrop: Story = {
  render: (args) => (
    <div style={{ display: "grid" }}>
      {(Object.keys(BACKDROPS) as Backdrop[]).map((backdrop) => (
        <div
          key={backdrop}
          style={{
            background: BACKDROPS[backdrop],
            // Deep enough that the crosshair's arms, which reach further
            // from the control than anything else here, are not clipped by
            // the row above: a mark judged through a crop is not judged.
            padding: "48px 36px",
            display: "flex",
            gap: 40,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {MARK_STYLES.map((style, i) => (
            <div
              key={style}
              style={{ display: "grid", gap: 24, justifyItems: "center" }}
            >
              <Mark
                kind="enclosure"
                style={style}
                strength={HAND_ENCLOSURE}
                approach={args.approach}
                seed={seedFor(0.2 + i / 9, 0.35)}
                dark={backdrop !== "document"}
              />
              <Caption text={style} dark={backdrop !== "document"} />
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
};

/**
 * One voice, swelling.
 *
 * The machine-drawn styles have no hand to wander, so the same knob means
 * something else in each of them: how far the weave swells, how far the
 * brackets stand off the control, how far the ping has travelled. Worth
 * looking at because the setting that reads as alive on a filament sheet is
 * the setting that reads as loose on a lock.
 */
export const StyleEnergy: Story = {
  args: { style: "filament" },
  render: (args) => {
    const dark = args.backdrop !== "document";
    const steps = Array.from(
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
        <div style={{ display: "flex", gap: 52, alignItems: "flex-start" }}>
          {steps.map((strength) => (
            <div
              key={strength}
              style={{ display: "grid", gap: 40, justifyItems: "center" }}
            >
              <Mark
                kind="enclosure"
                style={args.style}
                strength={strength}
                approach={args.approach}
                seed={seedFor(0.42, 0.42)}
                dark={dark}
              />
              <Mark
                kind="arrow"
                style={args.style}
                strength={strength}
                approach={args.approach}
                seed={seedFor(0.42, 0.42)}
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
 * The range of hands, on one backdrop.
 *
 * Read left to right and stop where it stops looking deliberate. The leftmost
 * is a machine and the rightmost is past what should ever ship; the answer is
 * one of the ones in between, and it is not obvious which without seeing them
 * together.
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
                style={args.style}
                strength={strength}
                approach={args.approach}
                seed={seedFor(0.3 + i / 10, 0.4)}
                dark={dark}
              />
              <Mark
                kind="arrow"
                style={args.style}
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
 * One hand, on every backdrop at once.
 *
 * The halo is the whole reason this story exists: an accent that reads on an
 * editor can vanish on a photograph, and the only way to know is to put them
 * beside each other.
 */
export const Legibility: Story = {
  args: { steps: 3 },
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
            style={args.style}
            strength={HAND_ENCLOSURE}
            approach={args.approach}
            seed={seedFor(0.5, 0.5)}
            dark={backdrop !== "document"}
          />
          <Mark
            kind="arrow"
            style={args.style}
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
              style={args.style}
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
              style={args.style}
              strength={HAND_ENCLOSURE}
              approach={args.approach}
              seed={seed}
              dark={dark}
            />
            <Mark
              kind="arrow"
              style={args.style}
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
