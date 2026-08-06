import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/**
 * A real assistant avatar, composed from the same bundled character components
 * the hatching screen uses, so what is on the pill is a genuine avatar rather
 * than a stand-in that happens to be round. Composed once at module scope: it
 * is a pure function of constants.
 */
const EXAMPLE_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  composeSvg(BUNDLED_COMPONENTS, "burst", "curious", "teal", 128),
)}`;

/**
 * The surface floats over other applications, so every story sits on a
 * stand-in desktop rather than the Storybook canvas. What is behind it is the
 * variable that decides whether the pill is readable, which is why it is a
 * control rather than a fixed backdrop.
 */
const BACKDROPS = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy: "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
};

type Backdrop = keyof typeof BACKDROPS;

type StoryArgs = React.ComponentProps<typeof CompanionSurface> & {
  backdrop: Backdrop;
};

const meta: Meta<StoryArgs> = {
  title: "Components/CompanionSurface",
  component: CompanionSurface,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    phase: {
      control: "inline-radio",
      options: ["resting", "hover", "call", "typing"],
    },
    backdrop: {
      control: "inline-radio",
      options: ["dark", "light", "busy"],
    },
    anchor: {
      control: "inline-radio",
      options: ["center", "left", "right"],
    },
    accentHex: { control: "color" },
    glow: { control: "boolean" },
  },
  args: {
    phase: "resting",
    glow: true,
    backdrop: "dark",
    avatarSrc: EXAMPLE_AVATAR,
  },
  decorators: [
    (Story, context) => {
      // The stand-in desktop is for the design stories. A story that brings its
      // own full-bleed backdrop (the demo reel) opts out, since decorators
      // compose rather than replace and it would otherwise render inside a
      // 560pt box with its own screen-sized content overflowing it.
      if (context.parameters.layout === "fullscreen") {
        return <Story />;
      }
      return (
        <div
          className="relative h-[340px] w-[560px] overflow-hidden rounded-xl"
          style={{
            background: BACKDROPS[(context.args as StoryArgs).backdrop ?? "dark"],
          }}
        >
          <Story />
        </div>
      );
    },
  ],
};

export default meta;

type Story = StoryObj<StoryArgs>;

/** The circle, as it sits when nobody is asking anything of it. */
export const Resting: Story = {
  args: { phase: "resting" },
};

/** Expanded with the app idle: the two ways in. */
export const Hover: Story = {
  args: { phase: "hover" },
};

/** Expanded mid-call: the session's own controls, at pill scale. */
export const InCall: Story = {
  args: { phase: "call" },
};

/**
 * The open contrast question, pinned as its own story so it cannot be lost in
 * a control. The pill assumes a dark desktop, and white on a 35% black scrim
 * stops being readable over a pale one.
 */
export const OnALightDesktop: Story = {
  args: { phase: "call", backdrop: "light" },
};

/**
 * Typing: the pill becomes a card with the tail of the conversation and
 * somewhere to answer it.
 *
 * Two turns at most, clamped to a few lines each, because this is a glance at
 * where the conversation got to rather than the conversation. The second turn
 * here overruns its clamp on purpose, so the cut is visible.
 */
export const Typing: Story = {
  args: {
    phase: "typing",
    assistantName: "Ziggy",
    turns: [
      { role: "user", text: "can you pull the deploy logs from this morning" },
      {
        role: "assistant",
        text: "Found them. The 09:14 deploy rolled back on its own after the health check failed twice, and the second attempt at 09:31 went through clean. The failing check was the one that talks to the queue, which was still draining from the migration you ran the night before, so nothing was actually wrong with the build itself. Want me to pull the queue depth over that window?",
      },
    ],
  },
};

/** The card before anything has been said. */
export const TypingEmpty: Story = {
  args: { phase: "typing", assistantName: "Ziggy", turns: [] },
};

/**
 * The circle parked hard against a screen edge, where bloom cannot bloom.
 *
 * It wants 72px of clearance either side expanded and 126px in a call, and
 * there is none to the left, so `anchor: "left"` pins that edge and grows the
 * body rightward instead. The avatar stays exactly where the user put it.
 *
 * **Set `anchor` to `center` to see why this exists.** Unclamped, the pill
 * grows straight past the edge and takes the avatar with it, so the surface
 * disappears off the side of the screen at the moment it is reached for.
 */
export const AgainstTheLeftEdge: Story = {
  args: { phase: "hover", anchor: "left" },
  decorators: [
    (Story) => (
      // A 44px column at the stage's left edge: the avatar's own footprint,
      // with the screen ending immediately to its left.
      <div className="absolute top-0 left-0 h-full w-11">
        <Story />
      </div>
    ),
  ],
};

/** The mirror case, where the body has to grow leftward instead. */
export const AgainstTheRightEdge: Story = {
  args: { phase: "call", anchor: "right" },
  decorators: [
    (Story) => (
      <div className="absolute top-0 right-0 h-full w-11">
        <Story />
      </div>
    ),
  ],
};

/**
 * The move itself, which is the thing being designed and the one thing a
 * static story cannot show. Expansion arms on the avatar alone, so the rest of
 * the desktop is dead space exactly as it is in the real window.
 *
 * Drop in an image to see the surface wearing a particular assistant. It never
 * leaves the browser: the file is read to a data URL and handed straight to the
 * component, which is also the shape the Electron payload arrives in.
 */
export const Interactive: Story = {
  args: { phase: "resting" },
  render: (args) => <HoverDrivenSurface {...args} />,
};

/**
 * Hover state lives in a component rather than in `render`, which is not one
 * and so may not hold hooks. The `phase` arg still wins when it is `call`, so
 * the control can pin the call state and hover keeps driving the idle one.
 */
function HoverDrivenSurface(args: StoryArgs) {
  const [hovered, setHovered] = useState(false);
  const [uploaded, setUploaded] = useState<string | undefined>();

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setUploaded(
        typeof reader.result === "string" ? reader.result : undefined,
      );
    };
    reader.readAsDataURL(file);
  };

  const phase: CompanionSurfacePhase =
    args.phase === "call" ? "call" : hovered ? "hover" : "resting";

  return (
    <>
      <CompanionSurface
        {...args}
        phase={phase}
        avatarSrc={uploaded ?? args.avatarSrc}
        onHoverStart={() => {
          setHovered(true);
        }}
        onHoverEnd={() => {
          setHovered(false);
        }}
      />
      <label className="absolute bottom-2 left-2 cursor-pointer rounded-md bg-black/50 px-2 py-1 text-[11px] text-white/80 backdrop-blur-sm">
        Use my own avatar
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFile}
        />
      </label>
      {uploaded !== undefined && (
        <button
          type="button"
          className="absolute bottom-2 left-[132px] rounded-md bg-black/50 px-2 py-1 text-[11px] text-white/80 backdrop-blur-sm"
          onClick={() => {
            setUploaded(undefined);
          }}
        >
          Reset
        </button>
      )}
    </>
  );
}

/**
 * A recording rig, not a design story.
 *
 * Drop in screenshots of a few apps and press play: each one holds for a couple
 * of seconds carrying exactly one beat of the surface, then the finale flips
 * them rapidly while the surface cycles. The point being made is that the
 * companion persists while the rest of the computer changes, so the apps have
 * to move faster than it does.
 *
 * One beat per app on purpose. Showing every state over every backdrop reads as
 * a feature tour; showing one state each reads as a thing that is simply there
 * while you work.
 *
 * The controls hide themselves while it plays, so a screen recording of this
 * window is the finished clip.
 */
export const DemoReel: Story = {
  args: {
    phase: "call",
  },

  parameters: { layout: "fullscreen" },
  render: (args) => <DemoReelPlayer {...args} />,
};

/** One app's moment: a backdrop, a state, and how long it holds. */
const DEMO_BEATS: {
  phase: CompanionSurfacePhase;
  hold: number;
  app: string;
}[] = [
  { phase: "resting", hold: 2000, app: "Browser: it is just there" },
  { phase: "hover", hold: 2000, app: "Notes: Talk or Type" },
  { phase: "call", hold: 2000, app: "Slack: listening" },
  { phase: "typing", hold: 2200, app: "Editor: say something" },
];

/** The payoff: the same states again, faster than the apps behind them. */
const DEMO_FINALE: CompanionSurfacePhase[] = [
  "resting",
  "hover",
  "call",
  "typing",
  "hover",
  "call",
  "resting",
];
const FINALE_HOLD = 480;

const DEMO_TURNS = [
  {
    role: "user" as const,
    text: "can you pull the deploy logs from this morning",
  },
  {
    role: "assistant" as const,
    text: "Found them. The 09:14 deploy rolled back on its own after the health check failed twice, and the second attempt at 09:31 went through clean.",
  },
];

function DemoReelPlayer(args: StoryArgs) {
  const [shots, setShots] = useState<string[]>([]);
  const [step, setStep] = useState<number | null>(null);

  // The whole timeline up front, so playback is one timer walking an array
  // rather than two phases with their own bookkeeping. Built once: it is a
  // function of module constants, and rebuilding it every render would restart
  // the timer that depends on it.
  const timeline = useMemo(
    () => [
      ...DEMO_BEATS.map((beat, index) => ({
        phase: beat.phase,
        hold: beat.hold,
        shot: index,
      })),
      ...DEMO_FINALE.map((phase, index) => ({
        phase,
        hold: FINALE_HOLD,
        shot: index,
      })),
    ],
    [],
  );

  useEffect(() => {
    if (step === null) {
      return;
    }
    if (step >= timeline.length) {
      setStep(null);
      return;
    }
    const timer = setTimeout(() => {
      setStep(step + 1);
    }, timeline[step].hold);
    return () => {
      clearTimeout(timer);
    };
  }, [step, timeline]);

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    Promise.all(
      files.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve(typeof reader.result === "string" ? reader.result : "");
            };
            reader.readAsDataURL(file);
          }),
      ),
    ).then((urls) => {
      setShots(urls.filter(Boolean));
    });
  };

  const playing = step !== null && step < timeline.length;
  const current = playing ? timeline[step] : null;
  const phase = current?.phase ?? "resting";
  // Screenshots cycle rather than run out, so three apps still carry four beats.
  const shotIndex =
    shots.length === 0 ? -1 : (current?.shot ?? 0) % shots.length;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0f1113]">
      {shots.map((shot, index) => (
        <img
          key={index}
          src={shot}
          alt=""
          className="absolute inset-0 size-full object-cover transition-opacity duration-300"
          style={{ opacity: index === shotIndex ? 1 : 0 }}
        />
      ))}
      {shots.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-[13px] text-white/40">
          Add screenshots below, then play.
        </div>
      )}

      {/* Parked where the real one parks: near the Dock, bottom right. */}
      <div className="absolute right-[12%] bottom-[14%] size-11">
        <CompanionSurface
          {...args}
          phase={phase}
          turns={DEMO_TURNS}
          assistantName={args.assistantName ?? "Ziggy"}
        />
      </div>

      {!playing && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-black/60 px-4 py-3 text-[12px] text-white/80">
          <label className="cursor-pointer rounded-md bg-white/10 px-2 py-1">
            Add screenshots
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onFiles}
            />
          </label>
          <button
            type="button"
            className="rounded-md bg-white/10 px-2 py-1 disabled:opacity-40"
            disabled={shots.length === 0}
            onClick={() => {
              setStep(0);
            }}
          >
            Play
          </button>
          <span className="text-white/40">
            {shots.length} loaded, {DEMO_BEATS.map((b) => b.app).join(" / ")},
            then the fast pass
          </span>
        </div>
      )}
    </div>
  );
}
