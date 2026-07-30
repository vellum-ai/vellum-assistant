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
  type VoiceWaveEngine,
} from "./voice-room-eyes";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import type { VoiceWavePalette, VoiceWaveStyle } from "./voice-listening-waves";
import { VoiceMeshWaves } from "./voice-mesh-waves";

// ---------------------------------------------------------------------------
// Amplitude drivers
// ---------------------------------------------------------------------------

/** How the harness sources the 0–1 amplitude every surface is driven by. */
type Driver = "mic" | "speech" | "silence" | "manual";

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
          wavePlacement="bottom"
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
  engine: "reactive",
  waveStyle: "fill",
  wavePalette: "tone",
  colorId: "green",
  eyeStyle: BUNDLED_COMPONENTS.eyeStyles[0]?.id ?? "grumpy",
  bodyShape: "blob",
};

const argTypes = {
  visual: { options: VISUALS, control: { type: "select" as const } },
  driver: {
    options: ["speech", "mic", "silence", "manual"] satisfies Driver[],
    control: { type: "inline-radio" as const },
    description:
      "mic = your real microphone (prompts for permission); speech = simulated envelope; silence = hard zero; manual = the slider.",
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
          muted={false}
          onToggleMute={() => {}}
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
