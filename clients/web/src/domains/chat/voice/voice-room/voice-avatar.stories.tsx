import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The `.voice-avatar-*` / `.voice-room-*` / `.voice-listening-waves` keyframes
// are hand-written rules in the app's global stylesheet, not Tailwind utilities
// — Storybook's preview.css only pulls Tailwind + tokens, so import the app CSS
// here to get the loops.
import "@/index.css";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import type { CharacterTraits } from "@/types/avatar";

import { toneForBg } from "@/utils/surface-tone";

import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import {
  VoiceListeningWaves,
  type VoiceWavePalette,
  type VoiceWavePlacement,
  type VoiceWaveStyle,
} from "./voice-listening-waves";
import { VoiceAvatar } from "./voice-avatar";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import {
  VoiceRoomColorLook,
  resolveVoiceRoomLook,
  type VoiceEyePlacement,
  type VoiceRespondingStyle,
} from "./voice-room-eyes";

/**
 * Iteration harness for the live-voice room's avatar + state animations. Scrub
 * `visual` through every session phase and drive the audio-reactive visuals
 * with the `amplitude` slider or the `oscillate` "simulated speech" toggle — no
 * live mic / STT / TTS session required.
 *
 * `listening` renders the bottom-edge waves (energy coming *in* from the user)
 * and the avatar stays at rest; `responding` is the avatar's own outward pulse
 * (energy going *out*). Wave `waveStyle` (fill / line) and `palette` (aurora /
 * accent) are the design knobs. `realAvatar` swaps the "V" fallback for a real
 * bundled character.
 *
 * Nothing hits the network: the real avatar is seeded into the query cache
 * below, on the room's own deep-dark `data-theme="dark"` void.
 */

// Sample avatar color: the seeded character's color drives both the avatar and
// the `accent` palette, so the harness faithfully shows the waves tinted to the
// avatar (as in the app, via `--avatar-accent`).
const SAMPLE_COLOR_ID = "purple";
const SAMPLE_ACCENT =
  BUNDLED_COMPONENTS.colors.find((c) => c.id === SAMPLE_COLOR_ID)?.hex ?? "#A665C9";
const SAMPLE_ASSISTANT_ID = "story-assistant";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
  },
});

// Seed a real bundled character so `realAvatar` renders without the daemon: a
// blob with the sample color, so its accent resolves and the waves tint to
// match. Seed both manifest-flag key variants so it resolves regardless of how
// the version gate reads in Storybook.
const seededAvatar = {
  components: BUNDLED_COMPONENTS,
  traits: {
    bodyShape: "blob",
    eyeStyle: "grumpy",
    color: SAMPLE_COLOR_ID,
  } as CharacterTraits,
  customImageUrl: null,
};
for (const supportsManifest of [false, true]) {
  queryClient.setQueryData(
    [...avatarQueryKey(SAMPLE_ASSISTANT_ID), supportsManifest],
    seededAvatar,
  );
}

const VISUALS: VoiceAvatarVisual[] = [
  "idle",
  "listening",
  "thinking",
  "responding",
  "reconnecting",
];

// Bundled trait ids for the color-look knobs — the same palette the picker
// draws from, so every avatar the app can render is scrubbable here.
const COLOR_IDS = BUNDLED_COMPONENTS.colors.map((c) => c.id);
const EYE_IDS = BUNDLED_COMPONENTS.eyeStyles.map((e) => e.id);
const BODY_IDS = BUNDLED_COMPONENTS.bodyShapes.map((b) => b.id);

/**
 * A stable `getAmplitude` backed by a ref: a static slider value, or a
 * simulated-speech envelope (~3.5 Hz syllabic tremor under a slower phrase
 * swell, plus jitter) when `oscillate` is on. Amplitude never flows through
 * React state, matching the real call sites.
 */
function useAmplitudeDriver(amplitude: number, oscillate: boolean): () => number {
  const ampRef = useRef(amplitude);

  useEffect(() => {
    if (!oscillate) {
      ampRef.current = amplitude;
    }
  }, [amplitude, oscillate]);

  useEffect(() => {
    if (!oscillate) {
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      const syllable = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 3.5);
      const phrase = 0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 0.4);
      const jitter = Math.random() * 0.12;
      ampRef.current = Math.min(1, Math.max(0, syllable * phrase * 0.9 + jitter));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [oscillate]);

  return useCallback(() => ampRef.current, []);
}

interface RoomSceneProps {
  visual: VoiceAvatarVisual;
  amplitude: number;
  oscillate: boolean;
  waveStyle: VoiceWaveStyle;
  palette: VoiceWavePalette;
  realAvatar: boolean;
  size?: number;
  minHeight?: number;
}

/**
 * A full room scene for one visual: the deep-dark void, ambient particles, the
 * bottom listening waves (only in `listening`), and the centered avatar — all
 * driven by one shared amplitude source so the avatar and waves move together.
 */
function RoomScene({
  visual,
  amplitude,
  oscillate,
  waveStyle,
  palette,
  realAvatar,
  size = 200,
  minHeight = 420,
}: RoomSceneProps) {
  const getAmplitude = useAmplitudeDriver(amplitude, oscillate);
  return (
    <div
      data-theme="dark"
      className="relative flex items-center justify-center overflow-hidden rounded-lg"
      style={{ background: "#05060b", minHeight, ["--avatar-accent" as string]: SAMPLE_ACCENT }}
    >
      <VoiceRoomAmbientBackground />
      {visual === "listening" ? (
        <VoiceListeningWaves
          getAmplitude={getAmplitude}
          waveStyle={waveStyle}
          palette={palette}
        />
      ) : null}
      <div className="relative z-0 flex items-center justify-center">
        <VoiceAvatar
          assistantId={realAvatar ? SAMPLE_ASSISTANT_ID : null}
          visual={visual}
          getAmplitude={getAmplitude}
          size={size}
        />
      </div>
    </div>
  );
}

/** Measure a box with a ResizeObserver — the color look sizes against it. */
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

interface ColorLookSceneProps {
  visual: VoiceAvatarVisual;
  amplitude: number;
  oscillate: boolean;
  eyePlacement: VoiceEyePlacement;
  wavePlacement: VoiceWavePlacement;
  waveStyle: VoiceWaveStyle;
  wavePalette: VoiceWavePalette;
  respondingStyle: VoiceRespondingStyle;
  colorId: string;
  eyeStyle: string;
  bodyShape: string;
  /** Bump to remount and replay the entrance animation. */
  replay: number;
  minHeight?: number;
}

/**
 * The color-with-eyes look for one avatar: the Introduction-step grow entrance
 * (body springs to fill, color fades in, eyes grow into place), the mic
 * waveform behind the eyes while `listening`, all in a measured box so the
 * geometry sizes against the story frame rather than the window. The whole
 * look remounts (replaying the entrance) whenever `replay` or any trait knob
 * changes.
 */
function ColorLookScene({
  visual,
  amplitude,
  oscillate,
  eyePlacement,
  wavePlacement,
  waveStyle,
  wavePalette,
  respondingStyle,
  colorId,
  eyeStyle,
  bodyShape,
  replay,
  minHeight = 520,
}: ColorLookSceneProps) {
  const driveAmplitude = useAmplitudeDriver(amplitude, oscillate);
  // Only `listening` (mic) and `responding` (TTS) are audio-reactive in the
  // real app; silence the driver in the other states so e.g. `thinking` shows
  // the eyes held steady-low, not bobbing.
  const getAmplitude = useCallback(
    () =>
      visual === "listening" || visual === "responding"
        ? driveAmplitude()
        : 0,
    [driveAmplitude, visual],
  );
  const { ref, size } = useBoxSize();
  const look = useMemo(
    () =>
      resolveVoiceRoomLook(
        BUNDLED_COMPONENTS,
        { bodyShape, eyeStyle, color: colorId },
        null,
      ),
    [bodyShape, eyeStyle, colorId],
  );
  const tone = look ? toneForBg(look.bgHex) : null;
  const toneVars = {
    "--room-fg": tone?.fg ?? "#FFFFFF",
    "--room-fg-muted": tone?.fgMuted ?? "rgba(255,255,255,0.7)",
    "--room-wash": tone?.wash ?? "rgba(255,255,255,0.1)",
    "--room-border": tone?.wash ?? "rgba(255,255,255,0.15)",
  } as Record<string, string>;

  return (
    <div
      ref={ref}
      data-theme={tone?.isLight ? "light" : "dark"}
      className="relative overflow-hidden rounded-lg"
      style={{ minHeight, ...toneVars }}
    >
      {look && size.w > 0 ? (
        <VoiceRoomColorLook
          // Remount on any trait/replay change so the entrance plays again.
          key={`${colorId}-${eyeStyle}-${bodyShape}-${eyePlacement}-${replay}`}
          look={look}
          visual={visual}
          getAmplitude={getAmplitude}
          eyePlacement={eyePlacement}
          wavePlacement={wavePlacement}
          waveStyle={waveStyle}
          wavePalette={wavePalette}
          respondingStyle={respondingStyle}
          viewport={size}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared + color-look controls (the color-with-eyes look is the app default).
// ---------------------------------------------------------------------------

const sharedArgTypes = {
  visual: { options: VISUALS, control: { type: "select" as const } },
  amplitude: {
    control: { type: "range" as const, min: 0, max: 1, step: 0.01 },
    description: "Static level (0–1). Ignored while Oscillate is on.",
  },
  oscillate: { control: { type: "boolean" as const } },
  waveStyle: {
    options: ["fill", "line"] satisfies VoiceWaveStyle[],
    control: { type: "inline-radio" as const },
    description: "Waveform: filled water vs stroked ribbon.",
  },
};

/** Defaults for the color-look stories. */
const colorArgs = {
  visual: "listening" as VoiceAvatarVisual,
  amplitude: 0.5,
  oscillate: true,
  waveStyle: "fill" as VoiceWaveStyle,
  eyePlacement: "center" as VoiceEyePlacement,
  wavePlacement: "top" as VoiceWavePlacement,
  wavePalette: "tone" as VoiceWavePalette,
  respondingStyle: "rings" as VoiceRespondingStyle,
  colorId: SAMPLE_COLOR_ID,
  eyeStyle: "grumpy",
  bodyShape: "blob",
  replay: 0,
};

const colorArgTypes = {
  ...sharedArgTypes,
  eyePlacement: {
    options: ["center", "bottom"] satisfies VoiceEyePlacement[],
    control: { type: "inline-radio" as const },
    description: "Eyes rest centered, or cut off at the bottom edge.",
  },
  wavePlacement: {
    options: ["top", "bottom", "center"] satisfies VoiceWavePlacement[],
    control: { type: "inline-radio" as const },
    description: "Waveform: sweeping in from the top edge, rising from the floor, or a centered band.",
  },
  wavePalette: {
    options: ["tone", "accent", "aurora"] satisfies VoiceWavePalette[],
    control: { type: "inline-radio" as const },
    description: "tone follows the room fg; accent = avatar hue; aurora = cyan→indigo.",
  },
  respondingStyle: {
    options: ["rings", "halo", "waveform", "pulse"] satisfies VoiceRespondingStyle[],
    control: { type: "inline-radio" as const },
    description: "Responding treatment (visible in the responding state).",
  },
  colorId: { options: COLOR_IDS, control: { type: "select" as const } },
  eyeStyle: { options: EYE_IDS, control: { type: "select" as const } },
  bodyShape: {
    options: BODY_IDS,
    control: { type: "select" as const },
    description: "Body shape that grows to fill on entrance.",
  },
  replay: {
    control: { type: "range" as const, min: 0, max: 20, step: 1 },
    description: "Bump to remount and replay the grow-in entrance.",
  },
};

const meta: Meta<typeof ColorLookScene> = {
  title: "Chat/Voice/VoiceAvatar",
  component: ColorLookScene,
  parameters: { layout: "fullscreen" },
  args: colorArgs,
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div style={{ padding: 24 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  argTypes: colorArgTypes,
};

export default meta;
type Story = StoryObj<typeof ColorLookScene>;
type VoidStory = StoryObj<typeof RoomScene>;

/**
 * Playground for the room's color-with-eyes look — every knob live. Change any
 * trait (or bump Replay) to replay the entrance: the body springs to fill, the
 * color fades in, and the eyes grow into place. The eyes stay centered and
 * change *size* per state; in `listening`, the mic waveform sweeps in from the
 * top edge with the simulated-speech driver and a state caption fades in below.
 */
export const Playground: Story = {};

/**
 * Every session state, all sharing the simulated-speech driver. The eyes stay
 * centered throughout and express the state by size (a smooth scale tween);
 * a soft caption names the beat below them:
 * - `idle` — eyes centered at a resting size, no treatment or caption.
 * - `listening` — eyes wide ("all ears"), the waveform sweeping in from the top
 *   edge, "Listening" below.
 * - `thinking` — eyes small, the dot triad just above them, "Thinking" below.
 * - `responding` — eyes medium, the responding treatment radiating outward,
 *   "Speaking" below.
 * - `reconnecting` — eyes at the resting size but dimmed.
 *
 * Scrub `visual` in the Playground to watch the size + caption cross-fade.
 */
export const States: Story = {
  render: (args) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {VISUALS.map((visual) => (
        <div key={visual} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">{visual}</span>
          <ColorLookScene
            {...args}
            visual={visual}
            eyePlacement="center"
            wavePlacement="top"
            minHeight={280}
          />
        </div>
      ))}
    </div>
  ),
};

/** The look across every avatar color, entrance playing in each. */
export const Colors: Story = {
  render: (args) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {COLOR_IDS.map((colorId) => (
        <div key={colorId} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">{colorId}</span>
          <ColorLookScene {...args} colorId={colorId} minHeight={300} />
        </div>
      ))}
    </div>
  ),
};

/**
 * Responding-state sketches, all in the responding state on the same
 * simulated-TTS driver — the eyes back up at center (engaged), each option a
 * different way of radiating the assistant's voice outward. Pick one; the rest
 * come out.
 */
export const RespondingSketches: Story = {
  name: "Responding — Sketches",
  args: { ...colorArgs, visual: "responding" },
  argTypes: colorArgTypes,
  render: (args) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {(["rings", "halo", "waveform", "pulse"] as const).map((respondingStyle) => (
        <div key={respondingStyle} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">
            {respondingStyle}
          </span>
          <ColorLookScene
            {...args}
            visual="responding"
            respondingStyle={respondingStyle}
            minHeight={340}
          />
        </div>
      ))}
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Void look — the deep-dark ambient fallback for custom-image / no-character
// avatars (kept for reference; the color look above is the default).
// ---------------------------------------------------------------------------

const voidArgs = {
  visual: "listening" as VoiceAvatarVisual,
  amplitude: 0.5,
  oscillate: true,
  waveStyle: "fill" as VoiceWaveStyle,
  palette: "accent" as VoiceWavePalette,
  realAvatar: true,
  size: 200,
};

const voidArgTypes = {
  ...sharedArgTypes,
  palette: {
    options: ["aurora", "accent", "tone"] satisfies VoiceWavePalette[],
    control: { type: "inline-radio" as const },
    description: "Fixed cyan→indigo, tinted from the avatar accent, or room-fg tone.",
  },
  realAvatar: {
    control: { type: "boolean" as const },
    description: "Real bundled character vs the “V” fallback.",
  },
  size: { control: { type: "range" as const, min: 80, max: 320, step: 4 } },
  // Color-look-only knobs — irrelevant to the void look.
  eyePlacement: { table: { disable: true } },
  wavePlacement: { table: { disable: true } },
  wavePalette: { table: { disable: true } },
  respondingStyle: { table: { disable: true } },
  colorId: { table: { disable: true } },
  eyeStyle: { table: { disable: true } },
  bodyShape: { table: { disable: true } },
  replay: { table: { disable: true } },
};

/** Void-look playground — the centered avatar, ambient void, and bottom waves. */
export const VoidLookPlayground: VoidStory = {
  name: "Void Look — Playground",
  render: (args) => <RoomScene {...args} />,
  args: voidArgs,
  argTypes: voidArgTypes,
};

/** Every state in the void look, all driven by the same simulated-speech envelope. */
export const VoidLookStates: VoidStory = {
  name: "Void Look — States",
  args: voidArgs,
  argTypes: voidArgTypes,
  render: (args) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {VISUALS.map((visual) => (
        <div key={visual} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">{visual}</span>
          <RoomScene {...args} visual={visual} size={140} minHeight={260} />
        </div>
      ))}
    </div>
  ),
};
