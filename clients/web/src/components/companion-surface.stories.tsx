import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import {
  CompanionIntro,
  introPhase,
  introSpotlight,
} from "@/components/companion-intro";
import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { composeSvg } from "@/utils/avatar-svg-compositor";
import {
  COMPANION_INTRO_BEATS,
  type CompanionIntroBeat,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";

/**
 * A session for the demo reel to draw.
 *
 * Listening and unmuted with nothing waiting on a decision: the ordinary middle
 * of a call, which is what the reel is showing.
 */
const DEMO_CALL: VoiceActivityState = {
  phase: "listening",
  label: "Listening",
  accentHex: "",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

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
 * The same creature as traits rather than pixels, which is how the real
 * surface receives it: composed live so it blinks, twitches and breathes, and
 * holds a focused pose while the turn is the assistant's.
 *
 * Clear `character` in the controls to see the custom-image fallback, which is
 * a still and does none of that.
 */
const EXAMPLE_CHARACTER = {
  bodyShape: "burst",
  eyeStyle: "curious",
  color: "teal",
};

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
  /**
   * Which beat the introduction opens on, for the `Introduction` story.
   *
   * A control rather than only a starting point, because the beats are what a
   * user meets the surface through once and each one has to be looked at on its
   * own: clicking through to the third every time to check the third is how a
   * beat goes unreviewed.
   */
  introBeat?: CompanionIntroBeat;
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
      options: ["resting", "hover", "watching", "call", "typing"],
    },
    backdrop: {
      control: "inline-radio",
      options: ["dark", "light", "busy"],
    },
    growth: {
      control: "inline-radio",
      options: ["right", "left"],
    },
    cardGrowth: {
      control: "inline-radio",
      options: ["up", "down"],
    },
    accentHex: { control: "color" },
    glow: { control: "boolean" },
    watching: { control: "boolean" },
    watchEnabled: { control: "boolean" },
    introBeat: {
      control: "inline-radio",
      options: COMPANION_INTRO_BEATS,
    },
  },
  args: {
    phase: "resting",
    glow: true,
    // On here, off everywhere a real user meets it until the flag says
    // otherwise. Design stories are for looking at what the surface can draw,
    // and a control the stories hid would be one nobody could review. Turn it
    // off to see the two-control row a user without the flag gets.
    watchEnabled: true,
    backdrop: "dark",
    avatarSrc: EXAMPLE_AVATAR,
    character: EXAMPLE_CHARACTER,
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
            background:
              BACKDROPS[(context.args as StoryArgs).backdrop ?? "dark"],
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

/**
 * Resting, with a turn running somewhere the user is not looking.
 *
 * The state the working ring exists for: the assistant is doing something and
 * nothing is open to say so. The ring has to carry that on its own, at the size
 * the surface actually spends its day.
 */
export const RestingWhileWorking: Story = {
  args: { phase: "resting", working: true },
};

/** The same turn with the pill open, where the ring follows the wider shape. */
export const HoverWhileWorking: Story = {
  args: { phase: "hover", hovered: true, working: true },
};

/**
 * The reply to something typed on the surface, while the card is still open.
 *
 * The card is the tallest and squarest thing the surface draws, so it is where
 * a ring written for a 44pt circle is most likely to come apart.
 */
export const TypingWhileWorking: Story = {
  args: {
    phase: "typing",
    working: true,
    assistantName: "Ziggy",
    turns: [{ role: "user", text: "what is on my calendar tomorrow?" }],
  },
};

/**
 * Expanded with the app idle: the two ways in.
 *
 * `hovered` is what the creature answers: the eyes widen while the hand is
 * over the surface. It is a separate arg from `phase` because a call holds the
 * pill open regardless of the pointer, and the mascot should still notice a
 * hand arriving mid-call.
 */
export const Hover: Story = {
  args: { phase: "hover", hovered: true },
};

/**
 * A session reading the screen, with the pointer nowhere near the surface.
 *
 * `hovered` is off on purpose: this is the state the phase exists for. The pill
 * stays open with no hand on it, Watch is held down, and the ring burns amber
 * rather than the assistant's own colour, so the running session is legible
 * from across the desk.
 *
 * The phase and the flag are both set because they answer different questions.
 * Turn `watching` off and the pill stays open on a row nothing is running
 * behind, which is what the phase alone means.
 *
 * Watch is the one control on this surface that is genuinely on or off, so it
 * is the one that reports a pressed state. Everything else the surface says
 * about a running session is a colour, and a colour reaches nobody who is
 * reading the page rather than looking at it.
 */
export const Watching: Story = {
  args: { phase: "watching", watching: true, hovered: false },
};

/**
 * The session is over and its summary is being written.
 *
 * A session ends twice. The socket closes on the stop press, and the account of
 * what was narrated is written afterwards by a turn that runs for the better
 * part of a minute. Collapsing to rest across that gap reads as the recording
 * having been thrown away, so the pill stays open and says what is happening.
 *
 * The ring is the session's amber rather than the assistant's accent, because
 * this is the same session finishing rather than an unrelated turn.
 */
export const SummaryPending: Story = {
  args: { phase: "summary", watchRetro: "pending", hovered: false },
};

/**
 * The summary is written, and the surface asks whether to open it.
 *
 * Two answers, both drawn. This surface floats over whatever the user does
 * next, so the way out of a question has to be as reachable as the way in: a
 * prompt whose only dismissal is going somewhere else is one that follows them
 * around. Not now is a deferral rather than a discard, since the report is
 * already in the assistant's conversation list under the session's own title.
 *
 * **Clear `watchRetro` to see what the phase alone means.** The row falls back
 * to the ordinary controls, which is right: nothing here should draw a question
 * with no answer behind it.
 */
export const SummaryReady: Story = {
  args: { phase: "summary", watchRetro: "ready", hovered: false },
};

/**
 * The same session, with the user mid-sentence in the composer.
 *
 * The phase the pill draws is `typing`, which outranks `watching`, and the
 * indicator survives it: the ring is the session's, not the phase's. This is
 * also the hardest geometry it has to hold, since the card is the one state
 * that is not a pill.
 *
 * The way out survives with it, in the composer's own trailing controls: the
 * idle row that carries Watch is not drawn here, and a ring the user can see
 * and cannot act on is a worse bargain than no ring at all. It sits on this row
 * rather than a row of its own because the card is already within ten points of
 * the height main sized the canvas for.
 *
 * **Turn `watching` off to see what an indicator drawn from the phase would
 * do.** The card goes dark, and the control goes with it, while the screen is
 * still being read.
 */
export const TypingWhileWatching: Story = {
  args: {
    phase: "typing",
    watching: true,
    assistantName: "Ziggy",
    turns: [{ role: "user", text: "what changed in this file?" }],
  },
};

/**
 * The same session again, with a call running over it.
 *
 * Two things are live and the surface has one edge to say so with, so the
 * capture takes it: the creature already carries the turn in its own pose,
 * and a call is a thing the user started and can hear.
 *
 * The widest row the surface draws outside the card: the activity line and five
 * controls, with the stop beside what the session is doing rather than beside
 * End, since two stops in a row is a misclick that ends the wrong one.
 */
export const InCallWhileWatching: Story = {
  args: { phase: "call", watching: true, call: DEMO_CALL },
};

/** Expanded mid-call: the session's own controls, at pill scale. */
export const InCall: Story = {
  args: { phase: "call" },
};

/**
 * Mid-call with a turn stopped on a confirmation.
 *
 * The decision takes the control row rather than crowding in beside it, which
 * is the same trade the iOS Lock Screen card makes: the turn is going nowhere
 * until this is answered, so it is the only thing here worth pressing. The
 * activity line says what is being asked; the pill is not the place to render a
 * tool call's arguments, and the app is a click away for that.
 *
 * This is the widest the surface ever gets, so it is what `MAX_PILL_WIDTH` in
 * `companion-window.ts` sizes the canvas to hold.
 */
export const PendingApproval: Story = {
  args: {
    phase: "call",
    call: {
      ...DEMO_CALL,
      phase: "thinking",
      label: "Thinking…",
      detail: "Read package.json",
      approvalRequestId: "req-1",
    },
  },
};

/**
 * The assistant's turn, which is what the mascot expresses.
 *
 * Compare with `InCall` above: same row, but the creature stops blinking and
 * holds the focused, morphing pose it uses in chat while a reply streams. The
 * words name the finer phase; the mascot says whose turn it is.
 */
export const InCallAssistantTurn: Story = {
  args: {
    phase: "call",
    call: {
      ...DEMO_CALL,
      phase: "thinking",
      label: "Thinking\u2026",
    },
  },
};

/** Mid-call with both mutes on, which is what the two buttons swap to. */
export const InCallMuted: Story = {
  args: {
    phase: "call",
    call: {
      ...DEMO_CALL,
      muted: true,
      outputMuted: true,
    },
  },
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
 * The card at the top of a display, where it has to unfurl downward.
 *
 * The vertical twin of `AgainstTheRightEdge`, and the fix for JARVIS-1548. The
 * host's canvas reserves the card's height on whichever side it grows into, and
 * macOS will not put a window frame above the top of the work area, so an
 * avatar that always reserved that height *above* itself could not be dragged
 * into the top of the screen at all. It stopped 270pt short, for no reason the
 * user could see.
 *
 * **Set `cardGrowth` to `up` to see the shape this replaces.** The card runs
 * straight off the top of the stage. The avatar holds its line either way,
 * which is the property this protects, exactly as the horizontal flip does.
 */
export const AgainstTheTopEdge: Story = {
  args: {
    phase: "typing",
    cardGrowth: "down",
    assistantName: "Ziggy",
    turns: [
      { role: "user", text: "what did the deploy do" },
      {
        role: "assistant",
        text: "Rolled back on its own after the health check failed twice, then went through clean at 09:31.",
      },
    ],
  },
  decorators: [
    (Story) => (
      // The avatar's own line, pinned near the top of the stage with the screen
      // ending just above it.
      <div className="absolute top-0 left-1/2 h-11 w-11 -translate-x-1/2">
        <Story />
      </div>
    ),
  ],
};

/**
 * The circle parked hard against the left edge, which changes nothing.
 *
 * Growth runs rightward, away from the edge, so this is simply the default
 * shape in a tight spot. It is here as the counterpart to the right edge, where
 * the direction does have to flip.
 */
export const AgainstTheLeftEdge: Story = {
  args: { phase: "hover", growth: "right" },
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

/**
 * The case that needs the flip: the circle parked against the right edge, where
 * the body has nowhere to run.
 *
 * **Set `growth` to `right` to see why this exists.** Unclamped, the body runs
 * straight off the display and takes the controls the user was reaching for
 * with it. The avatar itself stays exactly where it is either way, which is the
 * property the flip protects.
 */
export const AgainstTheRightEdge: Story = {
  args: { phase: "call", growth: "left" },
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
        hovered={hovered}
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
    phase: "resting",
  },

  parameters: { layout: "fullscreen" },
  render: (args) => <DemoReelPlayer {...args} />,
};

/**
 * The script, in order, one line per thing the viewer should notice.
 *
 * It reads as a single gesture rather than a tour: the companion is there, you
 * reach for it, you could type, you could talk instead, a call runs, and it
 * settles back to being there. It ends where it began on purpose, so the clip
 * loops without a seam.
 *
 * Holds are uneven because identical intervals read as a slideshow on a timer,
 * which is the opposite of the claim being made.
 */
const DEMO_STEPS: {
  phase: CompanionSurfacePhase;
  spotlight?: "talk" | "type";
  hold: number;
}[] = [
  { phase: "resting", hold: 2000 },
  { phase: "hover", spotlight: "type", hold: 1500 },
  { phase: "typing", hold: 2400 },
  { phase: "hover", spotlight: "talk", hold: 1500 },
  { phase: "call", hold: 3600 },
  { phase: "resting", hold: 2000 },
];

/**
 * How far the surface's state trails the app behind it.
 *
 * Switching both on the same frame reads as one cut, as though the surface were
 * part of the app that just appeared. Letting the backdrop land first and the
 * surface follow a beat later reads as what is being claimed: the computer
 * changed, and the companion carried on and responded in its own time.
 */
const PHASE_LAG = 620;

function DemoReelPlayer(args: StoryArgs) {
  const [shots, setShots] = useState<string[]>([]);
  const [step, setStep] = useState<number | null>(null);
  // Trails `step`. The backdrop is switched by `step` directly; the surface
  // waits out the lag before catching up, so the two never cut together.
  const [phaseStep, setPhaseStep] = useState(0);

  // The whole timeline up front, so playback is one timer walking an array
  // rather than two phases with their own bookkeeping. Built once: it is a
  // function of module constants, and rebuilding it every render would restart
  // the timer that depends on it.
  const timeline = useMemo(
    () =>
      DEMO_STEPS.map((step, index) => ({
        ...step,
        lag: PHASE_LAG,
        shot: index,
      })),
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

  useEffect(() => {
    if (step === null || step >= timeline.length) {
      return;
    }
    const timer = setTimeout(() => {
      setPhaseStep(step);
    }, timeline[step].lag);
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
  // The surface reads from the trailing index, the backdrop from the live one.
  const active = playing ? timeline[phaseStep] : null;
  const phase = active?.phase ?? "resting";
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
        // Held off centre, which is where the surface now sits.
        <div className="absolute inset-x-0 top-[30%] text-center text-[13px] text-white/40">
          Add screenshots below, then play.
        </div>
      )}

      {/* Centred rather than parked in a corner. The real surface lives near
          the Dock, but a corner puts it at the edge of frame where a viewer's
          eye is not, and the whole point of the clip is that the thing in the
          middle stays while everything around it moves. */}
      <div className="absolute top-1/2 left-1/2 size-11 -translate-x-1/2 -translate-y-1/2">
        <CompanionSurface
          {...args}
          phase={phase}
          spotlight={active?.spotlight}
          call={phase === "call" ? DEMO_CALL : undefined}
          // No turns: Type opens on the empty composer, which is the same
          // elongated single line as the states either side of it. Opening onto
          // a card of history would make this the one step that changes the
          // surface's shape, and the beat is about where you would type, not
          // about what was said earlier.
          turns={[]}
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
              setPhaseStep(0);
              setStep(0);
            }}
          >
            Play
          </button>
          <span className="text-white/40">
            {shots.length} loaded. Idle, Type, typing, Talk, a running call,
            idle.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The one-time introduction, walkable.
 *
 * The beats are what a user meets the surface through exactly once, so the
 * thing worth looking at here is the whole run rather than any one card: the
 * pill opening on the second beat, the spotlight moving between controls, and
 * the card holding still through all of it because it hangs off the avatar
 * rather than off the pill.
 *
 * Ends by starting over, which the real run pointedly does not do. Main records
 * that it has been seen and there is no way back into it from the app; this is
 * a story, and a story that could only be watched once would be useless.
 */
function IntroWalkthrough({ introBeat, ...args }: StoryArgs) {
  const [beat, setBeat] = useState<CompanionIntroBeat | null>(
    introBeat ?? COMPANION_INTRO_BEATS[0],
  );

  // Jumping straight to a beat from the controls panel, so each one can be
  // reviewed without walking to it.
  useEffect(() => {
    setBeat(introBeat ?? COMPANION_INTRO_BEATS[0]);
  }, [introBeat]);

  return (
    <CompanionSurface
      {...args}
      phase={introPhase(beat) ?? args.phase}
      spotlight={introSpotlight(beat)}
      intro={
        beat === null ? null : (
          <CompanionIntro
            beat={beat}
            growth={args.growth}
            cardGrowth={args.cardGrowth}
            accentHex={args.accentHex}
            onAdvance={(action) => {
              const next =
                action === "dismiss"
                  ? null
                  : (COMPANION_INTRO_BEATS[
                      COMPANION_INTRO_BEATS.indexOf(beat) + 1
                    ] ?? null);
              // Back to the top rather than gone, so the run can be watched
              // again without reloading the story.
              setBeat(next ?? COMPANION_INTRO_BEATS[0]);
            }}
          />
        )
      }
    />
  );
}

export const Introduction: Story = {
  args: { phase: "resting", introBeat: COMPANION_INTRO_BEATS[0] },
  render: (args) => <IntroWalkthrough {...args} />,
};

/**
 * The card with a reply that uses the formatting an assistant actually writes:
 * emphasis, inline code, and a short list. What the card does with markdown is
 * worth looking at rather than reasoning about, since it is 360pt wide and set
 * at 12px, and the primitive is authored for a full-width transcript.
 */
export const TypingWithMarkdown: Story = {
  args: {
    phase: "typing",
    turns: [
      { role: "user", text: "how do i reset the intro?" },
      {
        role: "assistant",
        text: '## Resetting it\n\nRun this with the app quit:\n\n```sh\njq \'del(.companionIntroSeen)\' "$f" > "$f.tmp" && mv "$f.tmp" "$f"\n```\n\n- It runs **once per install**\n- `companionHidden` must be `false`\n- The surface appears *after* sign-in',
      },
    ],
  },
};
