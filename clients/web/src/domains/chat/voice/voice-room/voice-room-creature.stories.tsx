import type { Meta, StoryObj } from "@storybook/react-vite";
import { useCallback, useEffect, useRef, useState } from "react";

// The wave / ring keyframes are hand-written rules in the app's global
// stylesheet (Storybook's preview.css only pulls Tailwind + tokens), so import
// the app CSS here to get the loops — same as voice-avatar.stories.tsx.
import "@/index.css";

import { toneForBg } from "@/utils/avatar-tone";

import type { VoiceAvatarVisual } from "./voice-avatar-state";
import { PAX_CREATURE } from "./pax-creature-asset";
import { VoiceRoomCreatureLook } from "./voice-room-creature";

/**
 * SPIKE harness for the "vellumized" creature look — a user-uploaded image
 * (a cowboy-hatted saguaro, "Pax") segmented, color-extracted, and given grafted
 * Vellum eyes, then rendered in the live-voice room with the SAME entrance,
 * eyes, waves, and rings a built character avatar gets.
 *
 * Scrub `visual` through every session phase and drive the audio-reactive
 * visuals with the `amplitude` slider or the `oscillate` "simulated speech"
 * toggle — no live mic / STT / TTS session required. The whole look remounts
 * (replaying the grow-in entrance) whenever `replay` changes.
 *
 * The question this is meant to answer: does an animated *real photo* with
 * grafted eyes feel magical, or uncanny?
 */

const VISUALS: VoiceAvatarVisual[] = [
  "idle",
  "listening",
  "thinking",
  "responding",
  "reconnecting",
];

/**
 * A stable `getAmplitude` backed by a ref: a static slider value, or a
 * simulated-speech envelope (~3.5 Hz syllabic tremor under a slower phrase
 * swell, plus jitter) when `oscillate` is on. Amplitude never flows through
 * React state, matching the real call sites.
 */
function useAmplitudeDriver(amplitude: number, oscillate: boolean): () => number {
  const ampRef = useRef(amplitude);
  useEffect(() => {
    if (!oscillate) ampRef.current = amplitude;
  }, [amplitude, oscillate]);
  useEffect(() => {
    if (!oscillate) return;
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
  }, [oscillate]);
  return useCallback(() => ampRef.current, []);
}

/** Measure a box with a ResizeObserver — the look sizes against it, not the window. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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

interface SceneProps {
  visual: VoiceAvatarVisual;
  amplitude: number;
  oscillate: boolean;
  /** Bump to remount and replay the entrance. */
  replay: number;
  minHeight?: number;
}

function CreatureScene({
  visual,
  amplitude,
  oscillate,
  replay,
  minHeight = 560,
}: SceneProps) {
  const driveAmplitude = useAmplitudeDriver(amplitude, oscillate);
  // Only `listening` (mic) and `responding` (TTS) are audio-reactive in the app.
  const getAmplitude = useCallback(
    () =>
      visual === "listening" || visual === "responding" ? driveAmplitude() : 0,
    [driveAmplitude, visual],
  );
  const { ref, size } = useBoxSize();

  // The room chrome (waves/caption) tones to the fill color, exactly as the app
  // sets the `--room-*` vars from `toneForBg(look.bgHex)`.
  const tone = toneForBg(PAX_CREATURE.fillHex);
  const toneVars = {
    "--room-fg": tone.fg,
    "--room-fg-muted": tone.fgMuted,
    "--room-wash": tone.wash,
    "--room-border": tone.wash,
  } as Record<string, string>;

  return (
    <div
      ref={ref}
      data-theme={tone.isLight ? "light" : "dark"}
      className="relative overflow-hidden rounded-lg"
      style={{ minHeight, ...toneVars }}
    >
      {size.w > 0 ? (
        <VoiceRoomCreatureLook
          // Remount when Replay changes so the grow-in entrance plays again.
          key={replay}
          creature={PAX_CREATURE}
          visual={visual}
          getAmplitude={getAmplitude}
          getResponseAmplitude={getAmplitude}
          viewport={size}
        />
      ) : null}
    </div>
  );
}

const meta: Meta<typeof CreatureScene> = {
  title: "Chat/Voice/VellumizedCreature (spike)",
  component: CreatureScene,
  parameters: { layout: "fullscreen" },
  args: {
    visual: "listening" as VoiceAvatarVisual,
    amplitude: 0.5,
    oscillate: true,
    replay: 0,
  },
  argTypes: {
    visual: { options: VISUALS, control: { type: "select" } },
    amplitude: {
      control: { type: "range", min: 0, max: 1, step: 0.01 },
      description: "Static level (0–1). Ignored while Oscillate is on.",
    },
    oscillate: { control: { type: "boolean" } },
    replay: {
      control: { type: "range", min: 0, max: 20, step: 1 },
      description: "Bump to remount and replay the grow-in entrance.",
    },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CreatureScene>;

/**
 * Playground — every knob live. Change Replay to replay the entrance: the amber
 * fills, Pax springs up to fill the room and breathes, and the grafted goofy
 * eyes grow in under the hat brim, then blink and follow the cursor.
 */
export const Playground: Story = {};

/**
 * Every session state, all sharing the simulated-speech driver — the grafted
 * eyes resize per state (wide listening, small thinking, medium responding),
 * a caption names the beat, and Pax breathes throughout.
 */
export const States: Story = {
  render: (args) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {VISUALS.map((visual) => (
        <div key={visual} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">{visual}</span>
          <CreatureScene {...args} visual={visual} minHeight={320} />
        </div>
      ))}
    </div>
  ),
};
