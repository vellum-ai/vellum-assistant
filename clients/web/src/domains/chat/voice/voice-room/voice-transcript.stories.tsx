import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

// The transcript reveal leans on the app's global CSS (content tokens, the
// `--room-*` vars) — Storybook's preview.css only pulls Tailwind, so import the
// app stylesheet to get them.
import "@/index.css";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { toneForBg } from "@/utils/avatar-tone";

import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceTranscriptText } from "./voice-transcript-text";

/**
 * Iteration harness for the voice room's live captions — a right-side chat rail
 * that streams the current turn word-by-word: user speech as a right-aligned
 * bubble, assistant speech as left-aligned muted plain text.
 *
 * The scenes simulate a live session by streaming a canned utterance into the
 * real live-voice store one word at a time (no mic / STT / TTS), so the reveal,
 * leading-edge tone, and partial→final hand-off all behave exactly as in the
 * app. Scrub `wordMs` for the pace of speech and bump `replay` to run the
 * utterance again.
 */

// A sample avatar color so the room tone (and the `--room-*` caption vars)
// resolve as they would over a real character look.
const SAMPLE_COLOR_ID = "purple";
const SAMPLE_HEX =
  BUNDLED_COMPONENTS.colors.find((c) => c.id === SAMPLE_COLOR_ID)?.hex ??
  "#A665C9";

const USER_LINE =
  "hey can you help me draft a quick note to the team about tomorrow's launch";
const ASSISTANT_LINE =
  "Of course — here's a short note you can send: the launch is on track for tomorrow morning, and I'll share the final checklist tonight so everyone's ready.";

type Role = "user" | "assistant" | "both";

/**
 * Stream `text` into a setter one word at a time, restarting whenever `replay`
 * or the pace changes. Returns nothing — it drives the store the component under
 * test reads from.
 */
function useWordStream(
  words: string[],
  wordMs: number,
  replay: number,
  onWord: (soFar: string) => void,
  onReset: () => void,
) {
  const onWordRef = useRef(onWord);
  const onResetRef = useRef(onReset);
  useEffect(() => {
    onWordRef.current = onWord;
    onResetRef.current = onReset;
  });
  useEffect(() => {
    onResetRef.current();
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      onWordRef.current(words.slice(0, i).join(" "));
      if (i >= words.length) {
        clearInterval(id);
      }
    }, wordMs);
    return () => clearInterval(id);
  }, [wordMs, replay, words]);
}

interface SceneProps {
  role: Role;
  wordMs: number;
  replay: number;
  minHeight?: number;
}

/** The real ambient transcript, over a toned room, fed by a simulated stream. */
function AmbientTranscriptScene({
  role,
  wordMs,
  replay,
  minHeight = 600,
}: SceneProps) {
  const tone = toneForBg(SAMPLE_HEX);
  const toneVars = {
    "--room-fg": tone.fg,
    "--room-fg-muted": tone.fgMuted,
    "--room-bubble-bg": tone.bubbleBg,
    "--room-bubble-fg": tone.bubbleFg,
  } as Record<string, string>;

  // Prefs gate each half; turn on whichever role this scene streams.
  useEffect(() => {
    const prefs = useVoicePrefsStore.getState();
    prefs.setShowUserTranscript(role === "user" || role === "both");
    prefs.setShowAssistantTranscript(role === "assistant" || role === "both");
    return () => {
      prefs.setShowUserTranscript(false);
      prefs.setShowAssistantTranscript(false);
    };
  }, [role]);

  const userWords = USER_LINE.split(" ");
  const assistantWords = ASSISTANT_LINE.split(" ");

  useWordStream(
    role === "assistant" ? [] : userWords,
    wordMs,
    replay,
    useCallback((soFar: string) => {
      useLiveVoiceStore.getState().setPartialTranscript(soFar);
    }, []),
    useCallback(() => {
      useLiveVoiceStore.getState().setPartialTranscript("");
      useLiveVoiceStore.getState().setFinalTranscript("");
    }, []),
  );
  useWordStream(
    role === "user" ? [] : assistantWords,
    wordMs,
    replay,
    useCallback((soFar: string) => {
      const store = useLiveVoiceStore.getState();
      store.clearAssistantTranscript();
      store.appendAssistantTranscript(soFar);
    }, []),
    useCallback(() => {
      useLiveVoiceStore.getState().clearAssistantTranscript();
    }, []),
  );

  return (
    <div
      data-theme={tone.isLight ? "light" : "dark"}
      className="relative flex items-center justify-center overflow-hidden rounded-lg"
      style={{ minHeight, backgroundColor: SAMPLE_HEX, ...toneVars }}
    >
      {/* Stand-in for the centered avatar so the rail reads against the right edge. */}
      <div
        className="size-40 rounded-full"
        style={{ backgroundColor: "var(--room-fg)", opacity: 0.12 }}
      />
      <VoiceAmbientTranscript />
    </div>
  );
}

const meta: Meta<typeof AmbientTranscriptScene> = {
  title: "Chat/Voice/Transcript",
  component: AmbientTranscriptScene,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  args: { role: "both", wordMs: 260, replay: 0 },
  argTypes: {
    role: {
      options: ["user", "assistant", "both"] satisfies Role[],
      control: { type: "inline-radio" },
      description:
        "Which half streams — user (right bubble), assistant (left plain text), or both.",
    },
    wordMs: {
      control: { type: "range", min: 80, max: 600, step: 20 },
      description: "Milliseconds between words — the pace of speech.",
    },
    replay: {
      control: { type: "range", min: 0, max: 20, step: 1 },
      description: "Bump to stream the utterance again.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof AmbientTranscriptScene>;

/**
 * The ambient captions over a live-streamed turn: each word fades + rises +
 * de-blurs in and the newest word carries the brighter leading-edge tone. The
 * rail sits against the room's right edge — the user's speech as a right-aligned
 * bubble, the assistant's as left-aligned muted text. Scrub `role` and `wordMs`.
 */
export const Playground: Story = {};

/**
 * The reveal mechanics in isolation — `VoiceTranscriptText` fed a plain growing
 * string, no store, on a neutral surface. Useful for tuning the per-word
 * entrance and the leading-edge tone without the room plumbing.
 */
export const Reveal: Story = {
  argTypes: {
    role: { table: { disable: true } },
    wordMs: {
      control: { type: "range", min: 80, max: 600, step: 20 },
    },
    replay: { control: { type: "range", min: 0, max: 20, step: 1 } },
  },
  args: { wordMs: 260, replay: 0 },
  render: (args) => <RevealScene wordMs={args.wordMs} replay={args.replay} />,
};

/**
 * The spoken-word cursor look: the full sentence has already
 * streamed in, but a static mid-sentence `highlightIndex` keeps the bright
 * leading-edge tone on the word currently being spoken — the text ahead of the
 * cursor stays muted instead of the highlight parking on the final word.
 */
export const SpokenWordHighlight: Story = {
  argTypes: {
    role: { table: { disable: true } },
    wordMs: { table: { disable: true } },
    replay: { table: { disable: true } },
  },
  render: () => (
    <CaptionSurface>
      <VoiceTranscriptText text={ASSISTANT_LINE} highlightIndex={9} />
    </CaptionSurface>
  ),
};

/** Neutral dark surface for the isolated caption scenes (no room plumbing). */
function CaptionSurface({ children }: { children: ReactNode }) {
  return (
    <div
      data-theme="dark"
      className="flex min-h-[240px] items-center justify-center rounded-lg p-10"
      style={{ backgroundColor: "#17191C" }}
    >
      <p className="max-w-[36rem] text-center text-[15px] leading-relaxed text-balance">
        {children}
      </p>
    </div>
  );
}

function RevealScene({ wordMs, replay }: { wordMs: number; replay: number }) {
  const [text, setText] = useState("");
  const words = ASSISTANT_LINE.split(" ");
  useWordStream(
    words,
    wordMs,
    replay,
    useCallback((soFar: string) => setText(soFar), []),
    useCallback(() => setText(""), []),
  );
  return (
    <CaptionSurface>
      <VoiceTranscriptText text={text} />
    </CaptionSurface>
  );
}
