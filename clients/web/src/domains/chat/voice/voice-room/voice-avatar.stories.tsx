import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useCallback, useEffect, useRef } from "react";

// The `.voice-avatar-*` / `.voice-room-*` / `.voice-listening-waves` keyframes
// are hand-written rules in the app's global stylesheet, not Tailwind utilities
// — Storybook's preview.css only pulls Tailwind + tokens, so import the app CSS
// here to get the loops.
import "@/index.css";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import type { CharacterTraits } from "@/types/avatar";

import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import {
  VoiceListeningWaves,
  type VoiceWavePalette,
  type VoiceWaveStyle,
} from "./voice-listening-waves";
import { VoiceAvatar } from "./voice-avatar";
import type { VoiceAvatarVisual } from "./voice-avatar-state";

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

const meta: Meta<typeof RoomScene> = {
  title: "Chat/Voice/VoiceAvatar",
  component: RoomScene,
  parameters: { layout: "fullscreen" },
  args: {
    amplitude: 0.5,
    oscillate: true,
    waveStyle: "fill",
    palette: "accent",
    realAvatar: true,
    size: 200,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div style={{ padding: 24 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  argTypes: {
    visual: { options: VISUALS, control: { type: "select" } },
    amplitude: {
      control: { type: "range", min: 0, max: 1, step: 0.01 },
      description: "Static level (0–1). Ignored while Oscillate is on.",
    },
    oscillate: { control: { type: "boolean" } },
    waveStyle: {
      options: ["fill", "line"] satisfies VoiceWaveStyle[],
      control: { type: "inline-radio" },
      description: "Listening waves: filled water vs stroked ribbon.",
    },
    palette: {
      options: ["aurora", "accent"] satisfies VoiceWavePalette[],
      control: { type: "inline-radio" },
      description: "Fixed cyan→indigo vs tinted from the avatar accent.",
    },
    realAvatar: {
      control: { type: "boolean" },
      description: "Real bundled character vs the “V” fallback.",
    },
    size: { control: { type: "range", min: 80, max: 320, step: 4 } },
  },
};

export default meta;
type Story = StoryObj<typeof RoomScene>;

/** Playground — every knob live. Defaults to the listening state so the waves + wave controls are visible. */
export const Playground: Story = {
  args: { visual: "listening" },
};

/**
 * The two audio-reactive states side by side (aurora / fill): `listening` reads
 * as energy coming *in* (waves rising toward a still, receptive avatar),
 * `responding` as energy going *out* (the avatar's own outward pulse).
 */
export const ListeningVsResponding: Story = {
  render: (args) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {(["listening", "responding"] as const).map((visual) => (
        <div key={visual} className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-white/60">{visual}</span>
          <RoomScene {...args} visual={visual} size={180} />
        </div>
      ))}
    </div>
  ),
};

/**
 * The four wave treatments to choose between — style (fill / line) × palette
 * (aurora / accent) — all in the listening state, sharing the simulated-speech
 * driver. The `accent` column is tinted from a sample avatar color.
 */
export const WaveVariants: Story = {
  render: (args) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {(["fill", "line"] as const).flatMap((waveStyle) =>
        (["aurora", "accent"] as const).map((palette) => (
          <div key={`${waveStyle}-${palette}`} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-white/60">
              {waveStyle} · {palette}
            </span>
            <RoomScene
              {...args}
              visual="listening"
              waveStyle={waveStyle}
              palette={palette}
              size={150}
              minHeight={300}
            />
          </div>
        )),
      )}
    </div>
  ),
};

/** Every visual side by side, all driven by the same simulated-speech envelope. */
export const AllStates: Story = {
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
