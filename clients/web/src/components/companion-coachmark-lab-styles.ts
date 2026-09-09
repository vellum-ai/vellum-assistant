/**
 * The mark styles that were tried and not chosen.
 *
 * **Kept because the record of what was rejected is what stops it being tried
 * again.** Ten machine-drawn voices were built beside the companion's own
 * hand and drawn against it in the lab: five woven from the voice room's mesh
 * (hairline curves phase shifted through one another, bright only where they
 * cross) and five instruments that hold a control rather than drawing round
 * it. The hand won. Every one of these is still legible over all three
 * backdrops, so the loss was not a fault in any of them.
 *
 * Beside the lab rather than in `companion-coachmark-shapes.ts` on purpose. A
 * style union in the module the renderer imports is a design decision left
 * unmade, and it is made: the marks are drawn in one hand, in one place, and
 * a user who sees one mark has seen them all. Nothing here is imported by
 * anything that ships.
 */

import {
  arrowPath,
  enclosurePath,
  HAND_MAX,
  type Approach,
} from "@/components/companion-coachmark-shapes";
import {
  noise,
  round,
  through,
  type Point,
} from "@/components/companion-coachmark-path";

/**
 * The voices a mark can be drawn in.
 *
 * **A mark is an interruption on someone else's screen, and how it is drawn is
 * what decides whether that reads as help or as damage.** `hand` is the
 * companion writing on the screen the way a person would over a colleague's
 * shoulder. Every other style is the same gesture said by a machine that is
 * listening, and they fall into two families.
 *
 * The **woven** ones are the voice room's mesh: hairline curves phase shifted
 * through one another, bright only where they cross, no blur anywhere. A mark
 * built from them is recognisably the assistant rather than an overlay some
 * app put there.
 *
 * The **instrument** ones do not draw a shape around the control at all. They
 * hold it: corners, ticks, scan bars, rings that have just passed over it.
 * Nothing crosses what is being pointed at, which is the one thing a loop can
 * never promise.
 *
 * They are options because this is not decidable by reasoning. The lab beside
 * this file draws them together, over the backdrops they have to survive, so
 * the pick is made by looking.
 */
export type MarkStyle =
  | "hand"
  | "filament"
  | "weave"
  | "ribbon"
  | "comb"
  | "waveform"
  | "reticle"
  | "caliper"
  | "scanline"
  | "crosshair"
  | "pulse";

/** The families, in the order they are worth comparing. */
export const MARK_FAMILIES: ReadonlyArray<{
  name: string;
  styles: readonly MarkStyle[];
}> = [
  { name: "hand", styles: ["hand"] },
  {
    name: "woven",
    styles: ["filament", "weave", "ribbon", "comb", "waveform"],
  },
  {
    name: "instrument",
    styles: ["reticle", "caliper", "scanline", "crosshair", "pulse"],
  },
];

/** Every style, flattened. */
export const MARK_STYLES: readonly MarkStyle[] = MARK_FAMILIES.flatMap(
  (family) => family.styles,
);

/**
 * One pass of a drawing.
 *
 * A mark is more than one stroke as soon as it stops being a single pen line:
 * a bundle of filaments is a dozen of them at graded weights, and a lock is
 * four brackets and a ring. `weight` and `alpha` are relative to whatever the
 * frame decides a mark's full stroke is, so a style says how it is layered
 * without knowing how thick anything ends up.
 */
export interface MarkStroke {
  d: string;
  /** Multiplier on the mark's base stroke width. */
  weight: number;
  /** 0 to 1, applied to the ink. The halo pass under it is the frame's own. */
  alpha: number;
}

/** A drawing that carries its own extent, since a tail decides the height. */
export interface MarkDrawing {
  strokes: readonly MarkStroke[];
  width: number;
  height: number;
}

/**
 * How far a sheet twists between its near and far edges, in radians.
 *
 * Lifted from the voice room's mesh, where it is the whole trick: at zero the
 * depths move as one and the bundle collapses into a single fat line, and
 * around half a turn the far edge rides the opposite part of the wave from the
 * near one, so the curves cross and the crossings are what read as bright.
 */
const DEPTH_PHASE = Math.PI * 0.78;

/** How many curves a woven mark is made of. */
const FILAMENTS = 9;

/**
 * The hand range read as a 0 to 1 dial, for the styles that have no hand.
 *
 * The lab drives every style from one knob so they can be judged against each
 * other at the same setting. On a machine-drawn mark it is not wobble: it is
 * how much the weave swells, how far the brackets stand off, how far a ping
 * has travelled.
 */
function energyOf(strength: number): number {
  return Math.min(Math.max(strength, 0), HAND_MAX) / HAND_MAX;
}

/** A straight run between two points. */
function segment(from: Point, to: Point): string {
  return `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`;
}

/** A small circle, for the nodes the instrument styles sit on their lines. */
function dot(centre: Point, r: number): string {
  return (
    `M ${round(centre.x - r)} ${round(centre.y)} ` +
    `a ${round(r)} ${round(r)} 0 1 0 ${round(r * 2)} 0 ` +
    `a ${round(r)} ${round(r)} 0 1 0 ${round(-r * 2)} 0`
  );
}

/** A closed ring sampled from `radius`, which is given the angle around it. */
function ring(
  centre: Point,
  radii: { rx: number; ry: number },
  radius: (angle: number) => number,
  steps = 26,
): string {
  const points: Point[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (Math.PI * 2 * i) / steps;
    const r = radius(angle);
    points.push({
      x: centre.x + Math.cos(angle) * radii.rx * r,
      y: centre.y + Math.sin(angle) * radii.ry * r,
    });
  }
  return through(points, true);
}

/** A polyline through `sample`, taken at `steps` even stations from 0 to 1. */
function trace(sample: (t: number) => Point, steps = 22): string {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(sample(i / steps));
  }
  return through(points, false);
}

/**
 * A chevron across `tip`, turned to `angle`.
 *
 * The machine-drawn heads are chevrons rather than barbs for the same reason
 * their loops are closed: a barb is a pen stroke doubling back, and nothing
 * here is holding a pen.
 */
function chevron(
  tip: Point,
  angle: number,
  size: number,
  spread: number,
): string {
  return (
    `M ${round(tip.x + Math.cos(angle - Math.PI + spread) * size)} ` +
    `${round(tip.y + Math.sin(angle - Math.PI + spread) * size)} ` +
    `L ${round(tip.x)} ${round(tip.y)} ` +
    `L ${round(tip.x + Math.cos(angle - Math.PI - spread) * size)} ` +
    `${round(tip.y + Math.sin(angle - Math.PI - spread) * size)}`
  );
}

/**
 * What every enclosure generator is handed.
 *
 * The geometry is worked out once rather than in each style, so a style is
 * only its own idea: which curves, at what weight. `random` is already seeded
 * off the anchor, so a style that draws from it stays deterministic.
 */
interface Around {
  box: { width: number; height: number };
  centre: Point;
  radii: { rx: number; ry: number };
  padding: number;
  energy: number;
  random: () => number;
}

/** What every arrow generator is handed, in the same spirit. */
interface Toward {
  width: number;
  height: number;
  mid: number;
  gap: number;
  tip: Point;
  /** The y of the shaft at `t`, tail at 0 and tip at 1. */
  along: (t: number) => number;
  barb: number;
  energy: number;
  random: () => number;
}

/** A sheet of curves around the control, phase shifted through each other. */
function sheet(
  { centre, radii, energy, random }: Around,
  options: { count?: number; direction?: number; shear?: number } = {},
): MarkStroke[] {
  const count = options.count ?? FILAMENTS;
  const direction = options.direction ?? 1;
  const shear = options.shear ?? 0;
  const twist = random() * Math.PI * 2;
  const lobes = 3 + Math.floor(random() * 3);
  const swell = 0.09 + energy * 0.16;
  return Array.from({ length: count }, (_, i) => {
    const depth = count === 1 ? 0.5 : i / (count - 1);
    const phase = twist + direction * depth * DEPTH_PHASE;
    // The sheet's near and far edges sit close enough to read as one surface
    // and far enough that the twist can pull the curves through each other.
    // Where they cross is the whole of the look: nothing here is painted
    // bright, the brightness is strokes landing on strokes.
    const spread = 1 + (depth - 0.5) * 0.22;
    return {
      d: ring(centre, radii, (angle) => {
        const along = angle + depth * shear;
        return (
          spread *
          (1 +
            Math.sin(along * lobes + phase) * swell +
            Math.sin(along * (lobes + 2) - phase * 0.6) * swell * 0.45)
        );
      }),
      weight: 0.34,
      alpha: 0.26 + depth * 0.62,
    };
  });
}

/** Every style's loop, keyed by style. */
const ENCLOSURES: Record<MarkStyle, (around: Around) => MarkStroke[]> = {
  hand: () => [],

  filament: (around) => sheet(around),

  /**
   * Two sheets wound the opposite way through each other.
   *
   * One sheet twists and its curves cross their neighbours. Two, counter
   * wound, cross each other as well, and the lattice that makes is denser
   * than either sheet could be on its own without closing into a solid.
   */
  weave: (around) => [
    ...sheet(around, { count: 6, direction: 1 }),
    ...sheet(around, { count: 6, direction: -1 }),
  ],

  /**
   * A sheet sheared along its own path rather than through its phase.
   *
   * Each depth is the same wave rotated a little further round the control,
   * so the crossings stretch into long spindles instead of scattering: a band
   * with a twist in it rather than a bundle.
   */
  ribbon: (around) => sheet(around, { count: 7, shear: 0.5 }),

  /**
   * The wave read as spokes, which is the voice room's band bent into a ring.
   *
   * Nothing encircles the control here: the spokes stand off it and their
   * lengths are the signal, so what the eye follows is a rhythm around the
   * thing rather than an outline of it. The bright ones are the crests.
   */
  comb: ({ centre, radii, energy, random }) => {
    const teeth = 34;
    const lobes = 3 + Math.floor(random() * 3);
    const phase = random() * Math.PI * 2;
    const reach = 0.2 + energy * 0.3;
    const strokes: MarkStroke[] = [
      { d: ring(centre, radii, () => 0.97), weight: 0.16, alpha: 0.24 },
    ];
    for (let i = 0; i < teeth; i += 1) {
      const angle = (Math.PI * 2 * i) / teeth;
      const swell = Math.abs(Math.sin(angle * lobes + phase));
      const out = 1 + reach * (0.25 + swell * 0.75);
      strokes.push({
        d: segment(
          {
            x: centre.x + Math.cos(angle) * radii.rx,
            y: centre.y + Math.sin(angle) * radii.ry,
          },
          {
            x: centre.x + Math.cos(angle) * radii.rx * out,
            y: centre.y + Math.sin(angle) * radii.ry * out,
          },
        ),
        weight: 0.32,
        alpha: 0.34 + swell * 0.6,
      });
    }
    return strokes;
  },

  /**
   * One trace read around the control, with a mirror running against it.
   *
   * The pair is what makes it a signal rather than a decorated ring: a band
   * for the crests to oscillate in, with the resting radius between them.
   */
  waveform: ({ centre, radii, energy, random }) => {
    const lobes = 5 + Math.floor(random() * 3);
    const phase = random() * Math.PI * 2;
    // Small, because a ring this size turns a big swing into gear teeth
    // rather than into a signal. What says wave here is a pair of traces
    // running against each other, not how far either one travels.
    const swell = 0.04 + energy * 0.05;
    const wave = (angle: number, sign: number) =>
      1 + sign * Math.sin(angle * lobes + phase) * swell;
    return [
      { d: ring(centre, radii, () => 1), weight: 0.16, alpha: 0.26 },
      {
        d: ring(centre, radii, (a) => wave(a, -1), 40),
        weight: 0.5,
        alpha: 0.6,
      },
      { d: ring(centre, radii, (a) => wave(a, 1), 40), weight: 1, alpha: 1 },
    ];
  },

  /**
   * A lock: four corners that say what is being held without a line crossing
   * it. The faint ring behind them is what keeps it from reading as a crop
   * tool, and the two ticks say the thing inside is being read rather than
   * merely framed.
   */
  reticle: (around) => {
    const { centre, box, radii, padding, energy } = around;
    const stand = padding + energy * 4;
    const edges = boundsOf(box, centre, stand);
    const arm = Math.min(box.width, box.height) * 0.45 + 3;
    return [
      { d: ring(centre, radii, () => 1.06), weight: 0.16, alpha: 0.22 },
      ...corners(edges, arm),
      {
        d: segment(
          { x: centre.x, y: edges.top - 5 },
          { x: centre.x, y: edges.top - 1 },
        ),
        weight: 0.6,
        alpha: 0.7,
      },
      {
        d: segment(
          { x: centre.x, y: edges.bottom + 1 },
          { x: centre.x, y: edges.bottom + 5 },
        ),
        weight: 0.6,
        alpha: 0.7,
      },
    ];
  },

  /**
   * The control measured rather than framed.
   *
   * Dimension lines above and below, with the serifs a drawing puts on the
   * ends of one, and the corner ticks kept short so the measurement is what
   * carries the mark. It says the assistant has read the thing's extent,
   * which is a different claim from having found it.
   */
  caliper: (around) => {
    const { centre, box, padding, energy } = around;
    const stand = padding + 1 + energy * 4;
    const edges = boundsOf(box, centre, stand);
    const serif = 4.5;
    const rule = (y: number): MarkStroke[] => [
      {
        d: segment({ x: edges.left, y }, { x: edges.right, y }),
        weight: 1,
        alpha: 1,
      },
      {
        d: segment(
          { x: edges.left, y: y - serif },
          { x: edges.left, y: y + serif },
        ),
        weight: 0.8,
        alpha: 1,
      },
      {
        d: segment(
          { x: edges.right, y: y - serif },
          { x: edges.right, y: y + serif },
        ),
        weight: 0.8,
        alpha: 1,
      },
    ];
    return [
      ...rule(edges.top),
      ...rule(edges.bottom),
      // The uprights are dropped to a whisper: they close the measurement
      // without becoming the box the dimension lines are measuring.
      {
        d: segment(
          { x: edges.left, y: edges.top },
          { x: edges.left, y: edges.bottom },
        ),
        weight: 0.18,
        alpha: 0.26,
      },
      {
        d: segment(
          { x: edges.right, y: edges.top },
          { x: edges.right, y: edges.bottom },
        ),
        weight: 0.18,
        alpha: 0.26,
      },
    ];
  },

  /**
   * The lock, mid-read.
   *
   * Corners plus bars travelling down the control. The bars are the one place
   * anything here crosses what is being pointed at, which is why they are
   * faint and why there are three of them: a pass over the thing, not a
   * hatching of it.
   */
  scanline: (around) => {
    const { centre, box, radii, padding, energy } = around;
    const stand = padding + energy * 3;
    const edges = boundsOf(box, centre, stand);
    const arm = Math.min(box.width, box.height) * 0.3 + 2;
    const bars = 3;
    const overhang = 3;
    return [
      { d: ring(centre, radii, () => 1.06), weight: 0.14, alpha: 0.2 },
      ...corners(edges, arm),
      ...Array.from({ length: bars }, (_, i) => {
        const at = (i + 1) / (bars + 1);
        const y = edges.top + (edges.bottom - edges.top) * at;
        return {
          d: segment(
            { x: edges.left - overhang, y },
            { x: edges.right + overhang, y },
          ),
          weight: 0.42,
          // Brightest at the leading bar, so the pass has a direction.
          alpha: 0.78 - i * 0.2,
        };
      }),
    ];
  },

  /**
   * Sights on the control, with the sights broken where it is.
   *
   * The four runs stop short and leave the control in a clear window: the
   * mark is entirely in the margin, and the node on each run is where the eye
   * lands before it follows the line in.
   */
  crosshair: (around) => {
    const { centre, box, radii, padding, energy } = around;
    const stand = padding + 2 + energy * 5;
    const edges = boundsOf(box, centre, stand);
    const run = Math.min(box.width, box.height) * 0.4 + 4;
    const arms: Array<[Point, Point]> = [
      [
        { x: edges.left - run, y: centre.y },
        { x: edges.left, y: centre.y },
      ],
      [
        { x: edges.right, y: centre.y },
        { x: edges.right + run, y: centre.y },
      ],
      [
        { x: centre.x, y: edges.top - run },
        { x: centre.x, y: edges.top },
      ],
      [
        { x: centre.x, y: edges.bottom },
        { x: centre.x, y: edges.bottom + run },
      ],
    ];
    return [
      { d: ring(centre, radii, () => 1.02), weight: 0.14, alpha: 0.2 },
      ...arms.map(([from, to]) => ({
        d: segment(from, to),
        weight: 1,
        alpha: 1,
      })),
      ...arms.map(([from]) => ({
        d: dot(from, 2.4),
        weight: 0.45,
        alpha: 0.9,
      })),
    ];
  },

  /**
   * A ping that has just passed over the control.
   *
   * One event caught mid-travel rather than three rings, which is why the
   * weight and the alpha fall together: a wave loses both as it goes.
   */
  pulse: ({ centre, radii, energy }) => {
    const rings = 3;
    const reach = 0.42 + energy * 0.34;
    return Array.from({ length: rings }, (_, i) => {
      const out = i / (rings - 1);
      return {
        d: ring(centre, radii, () => 1 + out * reach),
        weight: 1 - out * 0.72,
        alpha: 1 - out * 0.68,
      };
    });
  },
};

/** The rectangle a style stands its instrument off, `stand` outside the box. */
function boundsOf(
  box: { width: number; height: number },
  centre: Point,
  stand: number,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: centre.x - box.width / 2 - stand,
    right: centre.x + box.width / 2 + stand,
    top: centre.y - box.height / 2 - stand,
    bottom: centre.y + box.height / 2 + stand,
  };
}

/** The four corner brackets of `edges`, each arm `arm` long. */
function corners(
  edges: { left: number; right: number; top: number; bottom: number },
  arm: number,
): MarkStroke[] {
  const corner = (x: number, y: number, dx: number, dy: number) => ({
    d:
      `M ${round(x + dx * arm)} ${round(y)} L ${round(x)} ${round(y)} ` +
      `L ${round(x)} ${round(y + dy * arm)}`,
    weight: 1,
    alpha: 1,
  });
  return [
    corner(edges.left, edges.top, 1, 1),
    corner(edges.right, edges.top, -1, 1),
    corner(edges.right, edges.bottom, -1, -1),
    corner(edges.left, edges.bottom, 1, -1),
  ];
}

/**
 * Every style's loop, in one call.
 *
 * The frame asks for a mark around a box and gets back the passes to draw. A
 * style that is one stroke returns one; the woven ones return a sheet. Nothing
 * outside this file knows which is which.
 */
export function enclosureStrokes(
  style: MarkStyle,
  box: { width: number; height: number },
  options: { strength: number; seed: number; padding?: number },
): readonly MarkStroke[] {
  const padding = options.padding ?? 8;
  if (style === "hand") {
    return [
      { d: enclosurePath(box, { ...options, padding }), weight: 1, alpha: 1 },
    ];
  }
  return ENCLOSURES[style]({
    box,
    centre: { x: box.width / 2, y: box.height / 2 },
    radii: { rx: box.width / 2 + padding, ry: box.height / 2 + padding },
    padding,
    energy: energyOf(options.strength),
    random: noise(options.seed),
  });
}

/** A bundle of filaments converging on the tip. */
function bundle(
  { mid, width, along, energy, random }: Toward,
  options: { count?: number; direction?: number } = {},
): MarkStroke[] {
  const count = options.count ?? FILAMENTS;
  const direction = options.direction ?? 1;
  const twist = random() * Math.PI * 2;
  const cycles = 0.7 + random() * 0.3;
  const swing = width * (0.2 + energy * 0.24);
  return Array.from({ length: count }, (_, i) => {
    const depth = count === 1 ? 0.5 : i / (count - 1);
    const phase = twist + direction * depth * DEPTH_PHASE;
    return {
      // The bundle converges on the tip: the swing is scaled away as the
      // filaments arrive, so a sheet that is loose at the tail lands on one
      // point. A bundle that stayed open would be pointing at a region.
      d: trace((t) => ({
        x:
          mid +
          Math.sin(t * cycles * Math.PI * 2 + phase) *
            swing *
            (1 - t) *
            (1 - t),
        y: along(t),
      })),
      weight: 0.34,
      alpha: 0.26 + depth * 0.62,
    };
  });
}

/** Every style's stroke into a point, keyed by style. */
const ARROWS: Record<MarkStyle, (toward: Toward) => MarkStroke[]> = {
  hand: () => [],

  filament: (toward) => [
    ...bundle(toward),
    // Two chevrons rather than one, the near one carrying the weight: it
    // reads as a head at a glance and as a stack of filaments up close.
    {
      d: chevron(toward.tip, -Math.PI / 2, toward.barb, 0.5),
      weight: 0.9,
      alpha: 1,
    },
    {
      d: chevron(
        { x: toward.mid, y: toward.gap + toward.barb * 0.55 },
        -Math.PI / 2,
        toward.barb * 0.72,
        0.5,
      ),
      weight: 0.45,
      alpha: 0.55,
    },
  ],

  weave: (toward) => [
    ...bundle(toward, { count: 5, direction: 1 }),
    ...bundle(toward, { count: 5, direction: -1 }),
    {
      d: chevron(toward.tip, -Math.PI / 2, toward.barb, 0.5),
      weight: 0.9,
      alpha: 1,
    },
  ],

  /** The band, as its two edges with the weave running between them. */
  ribbon: (toward) => {
    const { mid, width, along, energy, random } = toward;
    const phase = random() * Math.PI * 2;
    const cycles = 0.8 + random() * 0.3;
    const swing = width * (0.18 + energy * 0.2);
    const edge = (sign: number, scale: number) =>
      trace((t) => ({
        x:
          mid +
          Math.sin(t * cycles * Math.PI * 2 + phase + sign * DEPTH_PHASE) *
            swing *
            scale *
            (1 - t) *
            (1 - t),
        y: along(t),
      }));
    return [
      { d: edge(-1, 1), weight: 0.55, alpha: 0.72 },
      { d: edge(0, 0.55), weight: 0.3, alpha: 0.4 },
      { d: edge(1, 1), weight: 0.55, alpha: 0.72 },
      {
        d: chevron(toward.tip, -Math.PI / 2, toward.barb, 0.46),
        weight: 1,
        alpha: 1,
      },
    ];
  },

  /** A spine with the wave read across it, rung by rung. */
  comb: (toward) => {
    const { mid, width, along, gap, height, energy, random } = toward;
    const rungs = 11;
    const phase = random() * Math.PI * 2;
    const cycles = 1.3 + random() * 0.5;
    const reach = width * (0.16 + energy * 0.2);
    return [
      {
        d: segment({ x: mid, y: height }, { x: mid, y: gap }),
        weight: 0.9,
        alpha: 1,
      },
      ...Array.from({ length: rungs }, (_, i) => {
        const t = i / rungs;
        const swell = Math.abs(Math.sin(t * cycles * Math.PI * 2 + phase));
        // The rungs shorten as they arrive, so the ladder narrows onto the
        // point rather than ending in a wall.
        const half = reach * (0.2 + swell * 0.8) * (1 - t);
        const y = along(t);
        return {
          d: segment({ x: mid - half, y }, { x: mid + half, y }),
          weight: 0.3,
          alpha: 0.34 + swell * 0.55,
        };
      }),
      {
        d: chevron(toward.tip, -Math.PI / 2, toward.barb, 0.46),
        weight: 1,
        alpha: 1,
      },
    ];
  },

  /** An oscilloscope trace settling onto the reading. */
  waveform: (toward) => {
    const { mid, width, along, energy, random } = toward;
    const cycles = 1.7 + random() * 0.5;
    const phase = random() * Math.PI * 2;
    const swing = width * (0.09 + energy * 0.13);
    const wave = (t: number, sign: number): Point => ({
      // Damped towards the tip, so the trace settles onto the point rather
      // than crossing it: an instrument arriving at a reading.
      x:
        mid +
        sign * Math.sin(t * cycles * Math.PI * 2 + phase) * swing * (1 - t),
      y: along(t),
    });
    return [
      { d: trace((t) => ({ x: mid, y: along(t) })), weight: 0.16, alpha: 0.22 },
      { d: trace((t) => wave(t, -1)), weight: 0.5, alpha: 0.6 },
      { d: trace((t) => wave(t, 1)), weight: 1, alpha: 1 },
      {
        d: chevron(toward.tip, -Math.PI / 2, toward.barb, 0.46),
        weight: 1,
        alpha: 1,
      },
    ];
  },

  /** A tracer: segments that brighten towards the point. */
  reticle: (toward) => {
    const { mid, along, height, barb, tip } = toward;
    const segments = 5;
    return [
      ...Array.from({ length: segments }, (_, i) => {
        const from = i / segments;
        const to = (i + 0.62) / segments;
        return {
          d: segment({ x: mid, y: along(from) }, { x: mid, y: along(to) }),
          weight: 0.5 + from * 0.5,
          alpha: 0.3 + from * 0.7,
        };
      }),
      {
        d: segment(
          { x: mid - barb * 0.42, y: height },
          { x: mid + barb * 0.42, y: height },
        ),
        weight: 0.5,
        alpha: 0.4,
      },
      { d: chevron(tip, -Math.PI / 2, barb, 0.4), weight: 1, alpha: 1 },
    ];
  },

  /** The shaft as a scale, which is the measuring hand of the same family. */
  caliper: (toward) => {
    const { mid, along, height, barb, tip } = toward;
    const ticks = 6;
    return [
      {
        d: segment({ x: mid, y: height }, { x: mid, y: along(0.94) }),
        weight: 1,
        alpha: 1,
      },
      {
        d: segment(
          { x: mid - barb * 0.4, y: height },
          { x: mid + barb * 0.4, y: height },
        ),
        weight: 0.8,
        alpha: 1,
      },
      ...Array.from({ length: ticks }, (_, i) => {
        const t = (i + 1) / (ticks + 1);
        // Every other tick is the long one, the way a rule is graduated.
        const long = i % 2 === 0;
        const y = along(t);
        return {
          d: segment({ x: mid, y }, { x: mid + barb * (long ? 0.34 : 0.2), y }),
          weight: 0.4,
          alpha: long ? 0.7 : 0.45,
        };
      }),
      { d: chevron(tip, -Math.PI / 2, barb, 0.42), weight: 1, alpha: 1 },
    ];
  },

  /** The shaft crossed by the pass that is reading it. */
  scanline: (toward) => {
    const { mid, along, height, barb, tip, width } = toward;
    const bars = 4;
    return [
      {
        d: segment({ x: mid, y: height }, { x: mid, y: along(0.94) }),
        weight: 0.8,
        alpha: 1,
      },
      ...Array.from({ length: bars }, (_, i) => {
        const t = (i + 0.5) / bars;
        const half = width * 0.16 * (1 - t * 0.5);
        const y = along(t);
        return {
          d: segment({ x: mid - half, y }, { x: mid + half, y }),
          weight: 0.3,
          alpha: 0.3 + t * 0.45,
        };
      }),
      { d: chevron(tip, -Math.PI / 2, barb, 0.44), weight: 1, alpha: 1 },
    ];
  },

  /** The run broken before the point, with the node where the eye lands. */
  crosshair: (toward) => {
    const { mid, along, height, barb, tip } = toward;
    const breakAt = 0.72;
    return [
      {
        d: segment({ x: mid, y: height }, { x: mid, y: along(breakAt) }),
        weight: 1,
        alpha: 1,
      },
      { d: dot({ x: mid, y: along(breakAt) }, 2.4), weight: 0.5, alpha: 0.85 },
      {
        d: segment({ x: mid, y: along(0.86) }, { x: mid, y: along(0.96) }),
        weight: 0.6,
        alpha: 0.7,
      },
      { d: chevron(tip, -Math.PI / 2, barb, 0.42), weight: 1, alpha: 1 },
    ];
  },

  /** A beam narrowing onto the point, with the ping's edge as the head. */
  pulse: (toward) => {
    const { mid, along, width, barb, tip, gap, energy } = toward;
    const flare = width * (0.1 + energy * 0.1);
    const edge = (sign: number) =>
      trace((t) => ({ x: mid + sign * flare * (1 - t), y: along(t) }), 6);
    return [
      { d: edge(-1), weight: 0.45, alpha: 0.5 },
      { d: edge(1), weight: 0.45, alpha: 0.5 },
      { d: trace((t) => ({ x: mid, y: along(t) }), 6), weight: 1, alpha: 1 },
      { d: chevron(tip, -Math.PI / 2, barb, 0.55), weight: 1, alpha: 1 },
      {
        d: chevron(
          { x: mid, y: gap + barb * 0.8 },
          -Math.PI / 2,
          barb * 0.6,
          0.55,
        ),
        weight: 0.5,
        alpha: 0.45,
      },
    ];
  },
};

/**
 * Every style's stroke into a point, in one call.
 *
 * Drawn pointing up, tail at the bottom, and turned by the caller when the
 * tail hangs above instead, exactly as {@link arrowPath} is: one geometry, so
 * the two directions cannot drift apart.
 */
export function arrowStrokes(
  style: MarkStyle,
  options: {
    length: number;
    approach: Approach;
    strength: number;
    seed: number;
    gap?: number;
  },
): MarkDrawing {
  const gap = options.gap ?? 10;
  if (style === "hand") {
    const drawn = arrowPath(options);
    return {
      strokes: [
        { d: drawn.shaft, weight: 1, alpha: 1 },
        { d: drawn.head, weight: 1, alpha: 1 },
      ],
      width: drawn.width,
      height: drawn.height,
    };
  }
  const height = options.length + gap;
  const width = Math.max(30, options.length * 0.6);
  const mid = width / 2;
  return {
    strokes: ARROWS[style]({
      width,
      height,
      mid,
      gap,
      tip: { x: mid, y: gap },
      // The stroke stops short of the point for the reason the loop sits
      // outside its bounds: what someone is being sent to has to stay visible.
      along: (t: number) => height - (height - gap) * t,
      barb: Math.max(10, options.length * 0.26),
      energy: energyOf(options.strength),
      random: noise(options.seed),
    }),
    width,
    height,
  };
}
