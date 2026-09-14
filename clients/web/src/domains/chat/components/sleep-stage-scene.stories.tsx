/**
 * The sleep stage's three scenes, driven by hand.
 *
 * In the app the stage only plays for an assistant that is genuinely asleep
 * and only on an arrival, so this is where the animation itself gets watched:
 * pick an eye style and a color, switch scenes, and see the lids move. The
 * `Waking up` story runs the real sequence end to end on a loop, which is the
 * one thing a static scene cannot show. `Light and dark` puts the two themes
 * side by side: the stage is dark in both, since the eyes' whites are a
 * near-white and so is the light surface, and this is where that holds or
 * does not. `Every color` runs the palette against that ground.
 *
 * The eye art comes from the bundled character catalog through the same
 * `resolveSleepStageEyes` the app uses, so what renders here is what ships.
 */

import { getCharacterComponents } from "@vellumai/avatar-catalog";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import {
  resolveSleepStageEyes,
  SleepStageView,
  WOKE_SEQUENCE_MS,
  type SleepStageScene,
} from "./sleep-stage-scene";

const CATALOG = getCharacterComponents();
const EYE_STYLES = CATALOG.eyeStyles.map((style) => style.id);
const COLORS = CATALOG.colors.map((color) => color.id);
/** A round-eyed default, so the first thing a reader sees is the common case
 *  rather than `grumpy`, whose art is a shallow squint to begin with. */
const DEFAULT_EYE_STYLE = EYE_STYLES.includes("bashful")
  ? "bashful"
  : EYE_STYLES[0]!;

function eyesFor(eyeStyle: string, color: string) {
  return resolveSleepStageEyes(
    CATALOG,
    {
      bodyShape: CATALOG.bodyShapes[0]!.id,
      eyeStyle,
      color,
    },
    null,
  );
}

interface StoryArgs {
  scene: SleepStageScene;
  eyeStyle: string;
  color: string;
  line: string;
}

/** A frame pinned to one theme, for the stories that show more than one. */
function ThemedStage({
  theme,
  children,
}: {
  theme: "light" | "dark";
  children: React.ReactNode;
}) {
  return (
    <div
      data-theme={theme}
      className="relative h-[560px] min-w-0 flex-1 overflow-hidden rounded-xl bg-[var(--surface-base)] p-6"
    >
      {children}
    </div>
  );
}

/** The stage is an inset layer, so the frame stands in for the chat `<main>`. */
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-[560px] w-full overflow-hidden rounded-xl bg-[var(--surface-base)]">
      {children}
    </div>
  );
}

function Scene({ scene, eyeStyle, color, line }: StoryArgs) {
  return (
    <Stage>
      <SleepStageView
        scene={scene}
        eyes={eyesFor(eyeStyle, color)}
        line={line}
        dismissLabel="Hide the sleep screen"
      />
    </Stage>
  );
}

const meta: Meta<StoryArgs> = {
  title: "Chat/SleepStage",
  parameters: { layout: "fullscreen" },
  argTypes: {
    scene: { control: "inline-radio", options: ["sleeping", "waking", "woke"] },
    eyeStyle: { control: "select", options: EYE_STYLES },
    color: { control: "select", options: COLORS },
    line: { control: "text" },
  },
  args: {
    scene: "sleeping",
    eyeStyle: DEFAULT_EYE_STYLE,
    color: COLORS[0]!,
    line: "Mel Gibson is asleep",
  },
  render: (args) => <Scene {...args} />,
};

export default meta;

type Story = StoryObj<StoryArgs>;

export const Asleep: Story = {};

export const Waking: Story = {
  args: { scene: "waking", line: "Mel Gibson is waking up…" },
};

export const Woke: Story = {
  args: { scene: "woke", line: "Mel Gibson just woke up" },
};

/**
 * Every eye style asleep at once. The lid is a share of the eye's height, so
 * this is where a creature whose art is already a squint gets checked against
 * one drawn as a pair of discs.
 */
export const EveryEyeStyle: Story = {
  name: "Every eye style",
  render: ({ color, scene }) => (
    <div className="grid grid-cols-3 gap-4 bg-[var(--surface-base)] p-4">
      {EYE_STYLES.map((eyeStyle) => (
        <div
          key={eyeStyle}
          className="relative h-[320px] overflow-hidden rounded-xl border border-[var(--border-base)]"
        >
          <SleepStageView
            scene={scene}
            eyes={eyesFor(eyeStyle, color)}
            line={eyeStyle}
            dismissLabel="Hide the sleep screen"
          />
        </div>
      ))}
    </div>
  ),
};

/**
 * The same scene in both themes at once. The app's surface is near-white in
 * light and near-black in dark, and the eyes' whites are near-white in both,
 * so the stage keeps its own dark ground in either: this is where that is
 * checked, with the frame around the stage showing the theme it sits in.
 */
export const LightAndDark: Story = {
  name: "Light and dark",
  render: ({ scene, eyeStyle, color, line }) => (
    <div className="flex flex-col gap-4 p-4 md:flex-row">
      {(["light", "dark"] as const).map((theme) => (
        <ThemedStage key={theme} theme={theme}>
          <SleepStageView
            scene={scene}
            eyes={eyesFor(eyeStyle, color)}
            line={line}
            dismissLabel="Hide the sleep screen"
          />
        </ThemedStage>
      ))}
    </div>
  ),
};

/**
 * Every palette color asleep at once. The lid is the avatar's color and the
 * whites of the eyes are fixed, so the lightest color (yellow) is the one to
 * watch against the stage's dark ground.
 */
export const EveryColor: Story = {
  name: "Every color",
  render: ({ eyeStyle, scene }) => (
    <div className="grid grid-cols-3 gap-4 bg-[var(--surface-base)] p-4">
      {COLORS.map((color) => (
        <div
          key={color}
          className="relative h-[320px] overflow-hidden rounded-xl border border-[var(--border-base)]"
        >
          <SleepStageView
            scene={scene}
            eyes={eyesFor(eyeStyle, color)}
            line={color}
            dismissLabel="Hide the sleep screen"
          />
        </div>
      ))}
    </div>
  ),
};

/**
 * The whole sequence the app plays: asleep, then waking, then the eyes open,
 * hold, and the stage fades off the conversation. Loops so it can be watched
 * more than once.
 */
export const WakingUp: Story = {
  name: "Waking up (sequence)",
  render: ({ eyeStyle, color }) => {
    return <Sequence eyeStyle={eyeStyle} color={color} />;
  },
};

const SEQUENCE: { scene: SleepStageScene; line: string; ms: number }[] = [
  { scene: "sleeping", line: "Mel Gibson is asleep", ms: 3200 },
  { scene: "waking", line: "Mel Gibson is waking up…", ms: 2600 },
  {
    scene: "woke",
    line: "Mel Gibson just woke up",
    ms: WOKE_SEQUENCE_MS + 600,
  },
];

function Sequence({ eyeStyle, color }: { eyeStyle: string; color: string }) {
  const [step, setStep] = useState(0);
  const beat = SEQUENCE[step % SEQUENCE.length]!;

  useEffect(() => {
    const timer = setTimeout(() => setStep((current) => current + 1), beat.ms);
    return () => clearTimeout(timer);
  }, [step, beat.ms]);

  return (
    <Stage>
      <SleepStageView
        // A new key on the last beat restarts the entrance, so the loop reads
        // as another sleep rather than a scene swap on a stage already up.
        key={Math.floor(step / SEQUENCE.length)}
        scene={beat.scene}
        eyes={eyesFor(eyeStyle, color)}
        line={beat.line}
        dismissLabel="Hide the sleep screen"
      />
    </Stage>
  );
}
