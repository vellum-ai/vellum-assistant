/**
 * Iteration harness for the *reactive* voice animations — the three surfaces a
 * live session can occupy, all on one amplitude source:
 *
 * 1. **Room — Desktop** — the full-screen color look, eyes and wave band.
 * 2. **Minimized — Composer Bar** — the inline strip that replaces the chat
 *    input's action row while the room is minimized.
 * 3. **Room — Mobile** — the same room in a phone frame.
 *
 * The point of the harness is the **Driver** knob. The old band's geometry was
 * authored once at mount and only slid sideways, so it looked identical whether
 * the mic was clipping or unplugged — the "it's just a PNG" read. Here the
 * geometry is rebuilt every frame from a rolling history of the amplitude, so
 * the surfaces should look obviously different per driver:
 *
 * - `mic` — **your actual microphone**, via `getUserMedia`. The honest test:
 *   talk, and the crest you make should travel left and decay off the edge.
 *   Storybook will prompt for permission the first time.
 * - `speech` — a simulated-speech envelope (syllabic tremor under a phrase
 *   swell), for iterating without talking to your laptop all afternoon.
 * - `silence` — a hard zero. The band should settle to its resting breath
 *   within about a second, *not* keep marching. If `silence` and `speech` look
 *   the same, the animation is not reactive and this harness has failed.
 * - `manual` — the Amplitude slider, for pinning a level and judging a pose.
 *
 * `Engine` A/Bs the new geometry against the original sine band on the same
 * driver, which is the fastest way to see what changed.
 *
 * Nothing hits the network or the daemon: the avatar is resolved from bundled
 * components and the amplitude comes from whichever driver is selected.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useCallback, useEffect, useRef, useState } from "react";

// The `.voice-listening-waves` / `.voice-room-eyes-reactive` rules are
// hand-written in the app's global stylesheet, not Tailwind utilities —
// Storybook's preview.css only pulls Tailwind + tokens.
import "@/index.css";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { toneForBg } from "@/utils/avatar-tone";

import { VoiceComposerBar } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

import {
  VoiceRoomColorLook,
  resolveVoiceRoomLook,
  type VoiceCaptionEmphasis,
  type VoiceRespondingStyle,
  type VoiceWaveEngine,
} from "./voice-room-eyes";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import type { VoiceWavePalette, VoiceWaveStyle } from "./voice-listening-waves";
import { VoiceMeshWaves, type VoiceMeshTuning } from "./voice-mesh-waves";

// ---------------------------------------------------------------------------
// Amplitude drivers
// ---------------------------------------------------------------------------

/** How the harness sources the 0–1 amplitude every surface is driven by. */
type Driver = "mic" | "speech" | "ramp" | "silence" | "manual";

/**
 * Match the app's own mic scaling so the harness is honest about levels:
 * `pcm-capture.ts` and `use-audio-amplitude.ts` both take an RMS, smooth it
 * with a 0.5 EMA, and scale by 14 before clamping to 1.
 */
const AMPLITUDE_SMOOTHING = 0.5;
const AMPLITUDE_SCALE = 14.0;

/**
 * A stable `getAmplitude` poll function for the selected driver.
 *
 * Amplitude never flows through React state here, matching every real call
 * site: the value lives in a ref that the surfaces' own rAF loops read. The
 * returned function is referentially stable, so swapping drivers never
 * restarts the consumers' loops.
 */
function useDriver(
  driver: Driver,
  manualAmplitude: number,
): { getAmplitude: () => number; micError: string | null } {
  const ampRef = useRef(0);
  const [micError, setMicError] = useState<string | null>(null);

  // Manual: mirror the slider into the ref.
  useEffect(() => {
    if (driver === "manual") {
      ampRef.current = manualAmplitude;
    }
  }, [driver, manualAmplitude]);

  // Silence: a hard zero, so the resting state can be judged honestly.
  useEffect(() => {
    if (driver === "silence") {
      ampRef.current = 0;
    }
  }, [driver]);

  // Ramp: a slow triangle through the whole 0–1 range. Speech envelopes jump
  // around too fast to tell "responds to amplitude" from "moves a lot", so this
  // is the driver to judge responsiveness on — anything that answers amplitude
  // should visibly swell and subside once per cycle.
  useEffect(() => {
    if (driver !== "ramp") {
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = ((performance.now() - start) / 1000) % 6;
      ampRef.current = t < 3 ? t / 3 : (6 - t) / 3;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [driver]);

  // Simulated speech: ~3.5 Hz syllabic tremor under a 0.4 Hz phrase swell,
  // plus jitter — the same envelope the existing voice stories use.
  useEffect(() => {
    if (driver !== "speech") {
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      const syllable = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 3.5);
      const phrase = 0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 0.4);
      ampRef.current = Math.min(
        1,
        Math.max(0, syllable * phrase * 0.9 + Math.random() * 0.12),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [driver]);

  // Real microphone. Held open only while `mic` is selected — the tracks are
  // stopped and the context closed on switch away, so Storybook does not sit
  // on the mic indicator all day.
  useEffect(() => {
    if (driver !== "mic") {
      return;
    }
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (!cancelled) {
          setMicError(
            error instanceof Error ? error.message : "Microphone unavailable",
          );
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setMicError(null);
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let smoothed = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) {
          const centered = sample / 128 - 1;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buffer.length);
        smoothed =
          AMPLITUDE_SMOOTHING * rms + (1 - AMPLITUDE_SMOOTHING) * smoothed;
        ampRef.current = Math.min(smoothed * AMPLITUDE_SCALE, 1);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      ampRef.current = 0;
    };
  }, [driver]);

  return { getAmplitude: useCallback(() => ampRef.current, []), micError };
}

/** Measure a box with a ResizeObserver — the room look sizes against it. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

/**
 * A live read-out of the amplitude the surfaces are being fed.
 *
 * This is the harness's control: if the number moves and the band does not,
 * the band is not reactive. Sampled at ~12 Hz rather than per frame — it is a
 * debug read-out, and it is the one place in this file allowed to re-render.
 */
function AmplitudeReadout({ getAmplitude }: { getAmplitude: () => number }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setValue(getAmplitude()), 80);
    return () => clearInterval(id);
  }, [getAmplitude]);
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-white/50">
      <span className="w-20 tabular-nums">amp {value.toFixed(3)}</span>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-white/70"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

interface SceneArgs {
  visual: VoiceAvatarVisual;
  driver: Driver;
  amplitude: number;
  engine: VoiceWaveEngine;
  waveStyle: VoiceWaveStyle;
  wavePalette: VoiceWavePalette;
  colorId: string;
  eyeStyle: string;
  bodyShape: string;
  respondingStyle: VoiceRespondingStyle;
  captionEmphasis: VoiceCaptionEmphasis;
  bandStrength: number;
}

/** The room's color look in a measured frame, driven by the selected source. */
function RoomFrame({
  args,
  getAmplitude,
  className,
  style,
}: {
  args: SceneArgs;
  getAmplitude: () => number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { ref, size } = useBoxSize();
  const look = resolveVoiceRoomLook(
    BUNDLED_COMPONENTS,
    {
      bodyShape: args.bodyShape,
      eyeStyle: args.eyeStyle,
      color: args.colorId,
    },
    null,
  );
  const tone = look ? toneForBg(look.bgHex) : null;

  // Only `listening` (mic) and `responding` (TTS) are audio-reactive in the
  // real app; silence the driver elsewhere so `thinking` holds steady rather
  // than bobbing to a signal it would never receive.
  const gated = useCallback(
    () =>
      args.visual === "listening" || args.visual === "responding"
        ? getAmplitude()
        : 0,
    [args.visual, getAmplitude],
  );

  return (
    <div
      ref={ref}
      data-theme={tone?.isLight ? "light" : "dark"}
      className={`relative overflow-hidden ${className ?? ""}`}
      style={{
        ...style,
        ["--room-fg" as string]: tone?.fg ?? "#FFFFFF",
        ["--room-fg-muted" as string]: tone?.fgMuted ?? "rgba(255,255,255,0.7)",
        ["--room-wash" as string]: tone?.wash ?? "rgba(255,255,255,0.1)",
      }}
    >
      {look && size.w > 0 ? (
        <VoiceRoomColorLook
          // Remount when the engine or traits change so the entrance replays
          // and the two engines start from the same clean state.
          key={`${args.engine}-${args.colorId}-${args.eyeStyle}-${args.bodyShape}`}
          look={look}
          visual={args.visual}
          getAmplitude={gated}
          waveEngine={args.engine}
          waveStyle={args.waveStyle}
          wavePalette={args.wavePalette}
          // Both voices sit on the floor and are told apart by ink instead
          // (see `BAND_VOICE`); `wavePlacement` still moves the listening band
          // to the ceiling if the split-by-position version is wanted back.
          wavePlacement="bottom"
          respondingStyle={args.respondingStyle}
          captionEmphasis={args.captionEmphasis}
          eyePlacement="center"
          viewport={size}
        />
      ) : null}
    </div>
  );
}

/** Driver controls + the amplitude read-out, shared by every story. */
function DriverBar({
  driver,
  getAmplitude,
  micError,
}: {
  driver: Driver;
  getAmplitude: () => number;
  micError: string | null;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-4">
      <span className="text-[13px] font-medium text-white/60">
        driver: {driver}
      </span>
      <AmplitudeReadout getAmplitude={getAmplitude} />
      {micError ? (
        <span className="text-[12px] text-red-400">mic: {micError}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const VISUALS: VoiceAvatarVisual[] = [
  "idle",
  "listening",
  "thinking",
  "responding",
  "reconnecting",
];

const defaultArgs: SceneArgs = {
  visual: "listening",
  driver: "speech",
  amplitude: 0.5,
  engine: "mesh",
  waveStyle: "fill",
  wavePalette: "tone",
  colorId: "green",
  eyeStyle: BUNDLED_COMPONENTS.eyeStyles[0]?.id ?? "grumpy",
  bodyShape: "blob",
  respondingStyle: "waves",
  captionEmphasis: "hidden",
  bandStrength: 1,
};

const argTypes = {
  visual: { options: VISUALS, control: { type: "select" as const } },
  driver: {
    options: ["speech", "mic", "ramp", "silence", "manual"] satisfies Driver[],
    control: { type: "inline-radio" as const },
    description:
      "mic = your real microphone (prompts for permission); speech = simulated envelope; ramp = a slow 0→1→0 sweep, the one to judge amplitude-responsiveness on; silence = hard zero; manual = the slider.",
  },
  amplitude: {
    control: { type: "range" as const, min: 0, max: 1, step: 0.01 },
    description: "Level for the `manual` driver. Ignored by the others.",
  },
  engine: {
    options: ["reactive", "mesh", "sine"] satisfies VoiceWaveEngine[],
    control: { type: "inline-radio" as const },
    description:
      "reactive = filled band rebuilt per frame from the amplitude history; mesh = the same signal as a woven wireframe sheet; sine = the original fixed silhouette.",
  },
  waveStyle: {
    options: ["fill", "line"] satisfies VoiceWaveStyle[],
    control: { type: "inline-radio" as const },
  },
  wavePalette: {
    options: ["tone", "accent", "aurora"] satisfies VoiceWavePalette[],
    control: { type: "inline-radio" as const },
  },
  colorId: {
    options: BUNDLED_COMPONENTS.colors.map((c) => c.id),
    control: { type: "select" as const },
  },
  eyeStyle: {
    options: BUNDLED_COMPONENTS.eyeStyles.map((e) => e.id),
    control: { type: "select" as const },
  },
  bodyShape: {
    options: BUNDLED_COMPONENTS.bodyShapes.map((b) => b.id),
    control: { type: "select" as const },
  },
  bandStrength: {
    control: { type: "range" as const, min: 0.25, max: 3, step: 0.05 },
    description:
      "Multiplier on the band's opacity ceiling (1 = the designer's 0.4 white / 0.2 black). Only affects the Band Strength story.",
  },
  captionEmphasis: {
    options: ["muted", "hidden", "full"] satisfies VoiceCaptionEmphasis[],
    control: { type: "inline-radio" as const },
    description:
      "How prominent the state caption is while audio flows. Only affects listening/responding — thinking always keeps its caption.",
  },
  respondingStyle: {
    options: [
      "waves",
      "rings",
      "halo",
      "waveform",
      "pulse",
    ] satisfies VoiceRespondingStyle[],
    control: { type: "inline-radio" as const },
    description:
      "waves = the band answering from the floor (the mirror of listening); the rest are the earlier radiate-from-the-eyes sketches.",
  },
};

const meta: Meta<SceneArgs> = {
  title: "Chat/Voice/Reactive Animations",
  parameters: { layout: "fullscreen" },
  args: defaultArgs,
  argTypes,
  decorators: [
    (Story) => (
      <div style={{ padding: 24, background: "#0b0d10", minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<SceneArgs>;

// ---------------------------------------------------------------------------
// Story scenes
//
// Each story renders one of these rather than calling hooks inside `render`:
// a Storybook `render` callback is not a component, so hooks there break the
// rules-of-hooks contract (and would not re-run cleanly on an args change).
// ---------------------------------------------------------------------------

/** Surface 1 — the full room at desktop proportions. */
function RoomDesktopScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <RoomFrame
        args={args}
        getAmplitude={getAmplitude}
        className="rounded-xl"
        style={{ height: "min(72vh, 640px)" }}
      />
    </div>
  );
}

/** Surface 2 — the minimized bar, inside a composer card. */
function ComposerBarScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  // The bar takes a session state, not a visual; map the two audio-bearing
  // visuals onto the states that keep the mic live.
  const state: LiveVoiceSessionState =
    args.visual === "responding" ? "speaking" : "listening";
  const accent =
    BUNDLED_COMPONENTS.colors.find((c) => c.id === args.colorId)?.hex ??
    "#3E9E8A";
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      {/* Judged inside the surface it ships in, not on a bare background. */}
      <div
        className="mx-auto max-w-3xl rounded-xl border border-white/10 bg-[#1b1e22]"
        style={{ ["--avatar-accent" as string]: accent }}
      >
        <VoiceComposerBar
          state={state}
          getAmplitude={getAmplitude}
          getOutputAmplitude={getAmplitude}
          muted={false}
          onToggleMute={() => {}}
          outputMuted={false}
          onToggleOutputMute={() => {}}
          fillIsLight={false}
          onEnd={() => {}}
          onExpand={() => {}}
          standalone
        />
      </div>
    </div>
  );
}

/** Surface 3 — the same room in a phone frame. */
function RoomMobileScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="flex justify-center">
        <div className="rounded-[44px] border-[10px] border-black bg-black shadow-2xl">
          <RoomFrame
            args={args}
            getAmplitude={getAmplitude}
            className="rounded-[34px]"
            style={{ width: 340, height: 700 }}
          />
        </div>
      </div>
    </div>
  );
}

/** Both engines on one shared amplitude source. */
function EngineComparisonScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {(["reactive", "mesh", "sine"] as const).map((engine) => (
          <div key={engine} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {engine}
              {engine === "sine" ? " (original)" : ""}
            </span>
            <RoomFrame
              args={{ ...args, engine }}
              getAmplitude={getAmplitude}
              className="rounded-xl"
              style={{ height: 420 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every session phase on one driver. */
function StatesScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {VISUALS.map((visual) => (
          <div key={visual} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {visual}
            </span>
            <RoomFrame
              args={{ ...args, visual }}
              getAmplitude={getAmplitude}
              className="rounded-xl"
              style={{ height: 320 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * Surface 1 — the full room on desktop. Switch **Driver** to `mic` and talk:
 * each syllable should raise a crest that travels left and decays off the
 * edge, and the eyes should widen with your voice. Set `responding` to see the
 * same machinery driven by the assistant's output instead.
 */
export const RoomDesktop: Story = {
  name: "Room — Desktop",
  render: (args) => <RoomDesktopScene {...args} />,
};

/**
 * Surface 2 — the minimized bar that replaces the chat input's action row.
 * Same engine as the room, at strip height with steeper gains. On `silence` it
 * should settle to a slow resting breath; on `mic` it should track speech
 * tightly enough to read as a level meter.
 */
export const MinimizedComposerBar: Story = {
  name: "Minimized — Composer Bar",
  render: (args) => <ComposerBarScene {...args} />,
};

/**
 * Surface 3 — the same room in a phone frame. The room is a full-app takeover
 * on every platform, so this is the desktop look at phone proportions: the
 * check is that the band still reads at a narrow width and the eyes still
 * clear the chrome.
 */
export const RoomMobile: Story = {
  name: "Room — Mobile",
  render: (args) => <RoomMobileScene {...args} />,
};

/**
 * The comparison that settles the question. All three frames share one
 * amplitude source, so every difference is the engine alone.
 *
 * Watch the **silhouette**, not the motion: the `sine` band's crests are a
 * fixed shape sliding at a constant rate — identical whether the driver is
 * `speech` or `silence` — while `reactive` and `mesh` are raised by the signal
 * and flatten without it. Switching the driver to `silence` is the clearest
 * demonstration: only one of the three frames fails to notice.
 */
export const EngineComparison: Story = {
  name: "Engine — Reactive vs Mesh vs Sine",
  render: (args) => <EngineComparisonScene {...args} />,
};

/**
 * Every session phase side by side on one driver, to check the hand-offs: the
 * band and the eye reaction should both be live in `listening` and
 * `responding`, and both still in `idle` / `thinking` / `reconnecting` — a
 * reaction in a phase that carries no audio is animating noise.
 */
export const States: Story = {
  render: (args) => <StatesScene {...args} />,
};

/**
 * The mesh engine on its own, big and on black — the reference aesthetic:
 * a woven wireframe sheet whose brightness is entirely emergent, piled up
 * where the folded surface crosses itself.
 *
 * Audio drives the *envelope*, not the ripple: a loud syllable swells the
 * sheet into a lobe that travels left and flattens, while the underlying weave
 * keeps its character. Drive it from `mic` and watch the lobe follow your
 * voice; on `silence` it settles to a slow resting breath rather than
 * flat-lining, so the surface never looks switched off.
 *
 * The band itself no longer travels: the shared placement CSS used to
 * translate the whole container on `--voice-amp`, which stacked a second
 * response on the same signal and read as the sheet bouncing behind its own
 * breathing. The mesh opts out of that (`--mesh` in `index.css`), so all the
 * vertical motion you see is the geometry answering the audio.
 *
 * `wavePalette` retints it: `aurora` is the reference cyan, `accent` takes the
 * avatar's hue, `tone` follows the room foreground.
 */
export const MeshShowcase: Story = {
  name: "Mesh — Showcase",
  args: { ...defaultArgs, engine: "mesh", wavePalette: "aurora" },
  render: (args) => <MeshShowcaseScene {...args} />,
};

/** The mesh alone on black, at the scale the reference is judged at. */
function MeshShowcaseScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div
        className="relative overflow-hidden rounded-xl bg-black"
        style={{
          height: "min(70vh, 620px)",
          ["--avatar-accent" as string]:
            BUNDLED_COMPONENTS.colors.find((c) => c.id === args.colorId)?.hex ??
            "#3E9E8A",
          ["--room-fg" as string]: "#FFFFFF",
        }}
      >
        <VoiceMeshWaves
          getAmplitude={getAmplitude}
          palette={args.wavePalette}
          placement="center"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mesh variants
// ---------------------------------------------------------------------------

/**
 * Tuning sketches for the mesh, each pulling on a different reason the default
 * can read as flat. The names describe the intent, not the numbers.
 */
const MESH_PRESETS: {
  name: string;
  note: string;
  tuning: Partial<VoiceMeshTuning>;
}[] = [
  {
    name: "filament (current default)",
    note: "edges almost coincident — the curves part only where the twist pulls them apart",
    tuning: {},
  },
  {
    name: "slack",
    note: "slower drift and broader lobes; the other one the designer liked",
    tuning: { driftSpeed: 0.42, cyclesA: 1.1, cyclesB: 1.9 },
  },
  {
    name: "broad lobes",
    note: "fewer cycles, so the sheet makes big sweeping swells instead of busy ripple",
    tuning: { cyclesA: 0.8, cyclesB: 1.5 },
  },
  {
    name: "hard twist",
    note: "a full turn across depth, so the sheet folds through itself more than once",
    tuning: { depthPhase: Math.PI * 3.1 },
  },
  {
    name: "dense (previous default)",
    note: "edges further apart — starts to read as ruled lines rather than one bundle",
    tuning: { spread: 0.12, displace: 0.4, alphaNear: 0.13 },
  },
  {
    name: "original (46 lines)",
    note: "the first tuning, for reference — a stack of lines, not a folded surface",
    tuning: {
      lines: 46,
      spread: 0.3,
      displace: 0.34,
      alphaFar: 0.07,
      alphaNear: 0.23,
    },
  },
];

/** One mesh preset on black, labelled. */
function MeshPresetCell({
  name,
  note,
  tuning,
  palette,
  getAmplitude,
}: {
  name: string;
  note: string;
  tuning: Partial<VoiceMeshTuning>;
  palette: VoiceWavePalette;
  getAmplitude: () => number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-white/70">{name}</span>
      <span className="text-[11px] leading-snug text-white/40">{note}</span>
      <div
        className="relative mt-1 overflow-hidden rounded-lg bg-black"
        style={{ height: 260 }}
      >
        <VoiceMeshWaves
          getAmplitude={getAmplitude}
          palette={palette}
          placement="center"
          tuning={tuning}
        />
      </div>
    </div>
  );
}

function MeshVariantsScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {MESH_PRESETS.map((preset) => (
          <MeshPresetCell
            key={preset.name}
            {...preset}
            palette={args.wavePalette}
            getAmplitude={getAmplitude}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Six tunings of the mesh on one shared amplitude source, so the differences
 * are the tuning alone.
 *
 * The knob that matters most is `spread` versus `displace`. The default keeps
 * the sheet's near and far edges 30% of the band apart, which is enough that
 * the curves read as *ruled lines at different heights* — a stack — before
 * they read as one folded surface. Pulling `spread` down toward ~0.08 makes
 * the curves nearly coincide, so the only thing separating them is the phase
 * twist, and the bundle starts behaving like the filaments in the reference.
 * Everything else here is secondary: line count and alpha decide whether the
 * weave resolves or reads as individual strokes, and the cycle counts decide
 * whether it makes broad lobes or busy ripple.
 */
export const MeshVariants: Story = {
  name: "Mesh — Variants",
  args: { ...defaultArgs, wavePalette: "aurora" },
  render: (args) => <MeshVariantsScene {...args} />,
};

/**
 * The spatial split, in one frame per phase: the user's voice arrives from the
 * **ceiling** while listening, the assistant's answers from the **floor** while
 * responding, and the eyes sit on the axis between them.
 *
 * The argument for it is that the room then says *who is speaking* by where the
 * energy is, using one visual language throughout — where the earlier `rings`
 * treatment answered the listening band with a different metaphor entirely
 * (concentric circles from behind the eyes), so a turn changing hands also
 * changed the vocabulary. Flip `respondingStyle` to `rings` to compare.
 */
export const TopBottomSplit: Story = {
  name: "Placement — Top / Bottom Split",
  args: { ...defaultArgs, driver: "speech" },
  render: (args) => <TopBottomSplitScene {...args} />,
};

function TopBottomSplitScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {(
          [
            ["listening", "user speaking — band at the ceiling"],
            ["responding", "assistant speaking — band at the floor"],
          ] as const
        ).map(([visual, label]) => (
          <div key={visual} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {label}
            </span>
            <RoomFrame
              args={{ ...args, visual }}
              getAmplitude={getAmplitude}
              className="rounded-xl"
              style={{ height: 520 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The three answers to "how loud should the words be while the visuals are
 * already talking", side by side in the listening state.
 *
 * The caption was written when the band was a fixed silhouette that could not
 * indicate anything on its own. Now that it visibly answers the microphone,
 * "Listening" is naming something the screen is already showing — and it sits
 * in the same lower zone the live transcript wants.
 *
 * - **muted** (default) — kept as a small dim label. Still legible if you look
 *   for it, no longer competing with the animation or the transcript.
 * - **hidden** — gone entirely while audio flows; the animation carries the
 *   state alone. The most honest to "nobody reads UI copy", and the one to
 *   pick if the band reads unambiguously on its own.
 * - **full** — the original weight, for comparison.
 *
 * `thinking` is deliberately exempt in every mode: it has no audio and no band,
 * so dropping its caption would leave a still, silent room with nothing saying
 * that work is happening. Scrub `visual` to `thinking` to confirm.
 */
export const CaptionEmphasis: Story = {
  name: "Caption — Emphasis",
  args: { ...defaultArgs, visual: "listening" },
  render: (args) => <CaptionEmphasisScene {...args} />,
};

function CaptionEmphasisScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {(["muted", "hidden", "full"] as const).map((captionEmphasis) => (
          <div key={captionEmphasis} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {captionEmphasis}
              {captionEmphasis === "muted" ? " (default)" : ""}
            </span>
            <RoomFrame
              args={{ ...args, captionEmphasis }}
              getAmplitude={getAmplitude}
              className="rounded-xl"
              style={{ height: 460 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Both voices on the floor, told apart by ink rather than by position.
 *
 * The earlier pass split them by edge — mic at the ceiling, reply at the
 * bottom — which read well but rearranged the room's whole composition twice
 * a turn. Here the layout holds still: the user's voice lifts a pale sheet off
 * the floor (white, 0.4 ceiling), the assistant's answers in a darker one
 * (black, 0.2), and the eyes never share the frame with a band overhead.
 *
 * Both fade from *nothing*, not from a resting visibility — displacement and
 * opacity both scale from zero, so between turns the floor is empty and the
 * band flattens away as the voice stops rather than cutting.
 *
 * Worth knowing: the dark band composites differently out of necessity, not
 * taste. The mesh's ridges come from overlapping strokes accumulating under
 * `lighter`, which is additive — black contributes zero and the sheet would
 * render invisible. Dark ink composites normally instead, accumulating toward
 * the ink rather than toward white. `compositeFor()` picks from luminance.
 */
export const InkSplit: Story = {
  name: "Placement — Ink Split (both on the floor)",
  args: { ...defaultArgs, driver: "speech" },
  render: (args) => <InkSplitScene {...args} />,
};

function InkSplitScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {(
          [
            ["listening", "user speaking — white, 0.4"],
            ["thinking", "between turns — the floor is empty"],
            ["responding", "assistant speaking — black, 0.2"],
          ] as const
        ).map(([visual, label]) => (
          <div key={visual} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {label}
            </span>
            <RoomFrame
              args={{ ...args, visual }}
              getAmplitude={getAmplitude}
              className="rounded-xl"
              style={{ height: 480 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A strength ladder for both voices, so the opacity ceilings can be picked by
 * eye rather than argued about in the abstract.
 *
 * The designer's numbers — white at 0.4, black at 0.2 — are the `1.0` column.
 * They read fainter than intended at first because two mistakes compounded:
 * the ceiling multiplied per-line alphas that had been calibrated against a
 * fully-opaque container, and opacity scaled linearly with amplitude on top of
 * a displacement that already did, so presence fell off with the *square* of
 * the signal. Both are fixed (`opacityKnee`, and full-strength base alphas), so
 * this ladder now moves the ceiling itself.
 *
 * Worth judging the two rows separately: the pale band accumulates additively
 * and saturates toward white, while the dark one composites normally and
 * accumulates toward the ink, so equal numbers do not read as equal presence.
 */
export const BandStrength: Story = {
  name: "Band — Strength Ladder",
  args: { ...defaultArgs, driver: "speech" },
  render: (args) => <BandStrengthScene {...args} />,
};

const STRENGTHS = [0.5, 1, 1.75, 2.5];

function BandStrengthScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      {(
        [
          ["listening", "user — white", 0.4],
          ["responding", "assistant — black", 0.2],
        ] as const
      ).map(([visual, label, base]) => (
        <div key={visual} className="mb-6">
          <div className="mb-2 text-[13px] font-medium text-white/60">
            {label}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {STRENGTHS.map((strength) => (
              <div key={strength} className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-white/45">
                  ×{strength} → {(base * strength).toFixed(2)}
                  {strength === 1 ? "  (designer's)" : ""}
                </span>
                <BandStrengthCell
                  args={args}
                  visual={visual}
                  strength={strength}
                  getAmplitude={getAmplitude}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One cell of the ladder. The strength multiplier is applied by overriding
 * `--band-peak-opacity` on a wrapper, which is the same variable the room's
 * per-voice ceiling sets — so this scales the real thing rather than
 * approximating it.
 */
function BandStrengthCell({
  args,
  visual,
  strength,
  getAmplitude,
}: {
  args: SceneArgs;
  visual: VoiceAvatarVisual;
  strength: number;
  getAmplitude: () => number;
}) {
  return (
    <div
      style={
        {
          "--band-strength": strength,
        } as React.CSSProperties
      }
      className="[&_.voice-listening-waves--mesh]:[opacity:calc(var(--band-presence,0)*var(--band-peak-opacity,1)*var(--band-strength,1))]"
    >
      <RoomFrame
        args={{ ...args, visual }}
        getAmplitude={getAmplitude}
        className="rounded-lg"
        style={{ height: 300 }}
      />
    </div>
  );
}

/**
 * The assistant band's amplitude response, on the ramp driver.
 *
 * `opacityKnee` sets how fast the band reaches its opacity ceiling: at 3 it is
 * fully opaque by a third of full amplitude and everything above that looks
 * identical. That is right for the *pale* band, whose silhouette reads clearly
 * enough that displacement can carry the dynamics on its own — but wrong for
 * the dark one, where the low-contrast silhouette means opacity is doing most
 * of the visible work, and saturating it early made the assistant's voice look
 * like it had stopped tracking amplitude at all.
 *
 * On the ramp driver each frame should visibly swell and subside once per
 * cycle. The lower the knee, the more of the amplitude range you can actually
 * see. 1.0 is perfectly linear; the room currently ships 1.3.
 */
export const RespondingResponse: Story = {
  name: "Band — Assistant Response Curve",
  args: { ...defaultArgs, driver: "ramp", visual: "responding" },
  render: (args) => <RespondingResponseScene {...args} />,
};

const KNEES = [1, 1.3, 2, 3];

function RespondingResponseScene(args: SceneArgs) {
  const { getAmplitude, micError } = useDriver(args.driver, args.amplitude);
  return (
    <div>
      <DriverBar
        driver={args.driver}
        getAmplitude={getAmplitude}
        micError={micError}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {KNEES.map((knee) => (
          <div key={knee} className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-white/45">
              knee {knee.toFixed(1)}
              {knee === 1 ? "  (linear)" : ""}
              {knee === 1.3 ? "  (shipping)" : ""}
              {knee === 3 ? "  (was)" : ""}
            </span>
            <div
              style={{ ["--band-knee" as string]: knee }}
              className="[&_.voice-listening-waves--mesh]:[opacity:calc(min(1,var(--voice-amp,0)*var(--band-knee,1))*var(--band-peak-opacity,1))]"
            >
              <RoomFrame
                args={{ ...args, visual: "responding" }}
                getAmplitude={getAmplitude}
                className="rounded-lg"
                style={{ height: 320 }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
