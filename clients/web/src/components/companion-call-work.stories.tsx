import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { useEffect, useState } from "react";

import type {
  CompanionDock,
  VoiceActivityState,
  VoiceActivityWork,
} from "@vellumai/ipc-contract";

import { CompanionSurface } from "@/components/companion-surface";

/**
 * The work a call is carrying, on the call's bar: a count on the row in every
 * phase, and a press on it opens the list joined to the bar. The foreground
 * turn is on the list while it is on a tool step, which is also when the bar
 * reads "Working on that…"; sub-agents are on it from spawn to a beat after
 * they finish.
 *
 * The surface is the real one; press the count to open the list.
 */
const meta: Meta = {
  title: "Companion/Call work",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

const ACCENT = "#5eead4";
const CHARACTER = { bodyShape: "burst", eyeStyle: "curious", color: "teal" };

const CALL: VoiceActivityState = {
  phase: "listening",
  label: "Listening…",
  accentHex: ACCENT,
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
  work: [],
};

type Phase = "listening" | "thinking" | "working" | "speaking";

const PHASES: Record<Phase, Pick<VoiceActivityState, "phase" | "label">> = {
  listening: { phase: "listening", label: "Listening…" },
  thinking: { phase: "thinking", label: "Thinking…" },
  working: { phase: "thinking", label: "Working on that…" },
  speaking: { phase: "speaking", label: "Speaking…" },
};

/** A clock the stories count elapsed time against. */
const START = Date.now();

interface Stream {
  id: string;
  kind: VoiceActivityWork["kind"];
  title: string;
  /** When each step starts, in seconds. An empty step is between steps. */
  steps: [at: number, step: string][];
  settles?: [at: number, state: "done" | "failed"];
  /** When it drops off the list. */
  gone: number;
}

const STREAMS: Stream[] = [
  {
    id: "turn",
    kind: "turn",
    title: "Ziggy",
    steps: [
      [1.2, "Checking your calendar"],
      [2.2, "Starting a helper"],
      [2.8, ""],
      [5, "Searching the web"],
      [6.2, "Starting a helper"],
      [6.8, ""],
      [13.8, "Reading the draft"],
      [14.6, ""],
    ],
    gone: Infinity,
  },
  {
    id: "flights",
    kind: "subagent",
    title: "Flights to Lisbon",
    steps: [
      [2.6, "Searching the web"],
      [4.2, "Reading kayak.com"],
      [6.6, "Comparing 12 flights"],
      [9, "Checking seat maps"],
    ],
    settles: [11, "done"],
    gone: 15,
  },
  {
    id: "email",
    kind: "subagent",
    title: "Email to Bob",
    steps: [
      [6.6, "Reading your last thread"],
      [8.6, "Writing a draft"],
      [11.6, "Checking the tone"],
    ],
    settles: [15.4, "done"],
    gone: 19.4,
  },
];

const SCRIPT_PHASES: [at: number, phase: Phase][] = [
  [0, "listening"],
  [1, "thinking"],
  [2.8, "speaking"],
  [4.4, "listening"],
  [5, "thinking"],
  [6.8, "speaking"],
  [8.4, "listening"],
  [13, "thinking"],
  [14.6, "speaking"],
  [16, "listening"],
];

const LOOP = 20.5;

const latest = <T,>(marks: [number, T][], t: number): T | undefined =>
  [...marks].reverse().find(([at]) => at <= t)?.[1];

/** The call at a second of the script, as the mirror would send it. */
function callAt(t: number): VoiceActivityState {
  const work: VoiceActivityWork[] = [];
  for (const stream of STREAMS) {
    const first = stream.steps[0]![0];
    if (t < first || t >= stream.gone) {
      continue;
    }
    const step = latest(stream.steps, t) ?? "";
    if (stream.kind === "turn" && step === "") {
      continue;
    }
    const settled =
      stream.settles !== undefined && t >= stream.settles[0]
        ? stream.settles[1]
        : null;
    work.push({
      id: stream.id,
      kind: stream.kind,
      title: stream.title,
      step: settled === null ? step : "",
      state: settled ?? "running",
      startedAt: START - (t - first) * 7000,
    });
  }
  const reported = latest(SCRIPT_PHASES, t) ?? "listening";
  const onStep = work.some((item) => item.kind === "turn");
  const phase = reported === "thinking" && onStep ? "working" : reported;
  return { ...CALL, ...PHASES[phase], work };
}

function Stage({
  call,
  dock,
}: {
  call: VoiceActivityState;
  dock?: CompanionDock;
}) {
  const side = dock === "left" || dock === "right";
  return (
    <div
      data-theme="dark"
      className="relative overflow-hidden rounded-xl"
      style={{
        width: 720,
        height: side ? 520 : 300,
        background:
          "radial-gradient(120% 90% at 20% 10%, #b3391d 0%, transparent 60%), linear-gradient(140deg, #8e2a14 0%, #6d1f10 55%, #4a150b 100%)",
      }}
    >
      <div className="absolute inset-0">
        <CompanionSurface
          phase="call"
          call={call}
          assistantName="Ziggy"
          accentHex={ACCENT}
          character={CHARACTER}
          dock={dock}
        />
      </div>
    </div>
  );
}

/** Press every count on the page, which opens each list. */
const openLists = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  for (const chip of canvasElement.querySelectorAll<HTMLElement>(
    'button[data-control="work"]',
  )) {
    await userEvent.click(chip);
  }
};

/** Two sub-agents and the turn's own step, with the list open. */
export const ListOpen: Story = {
  render: () => <Stage call={callAt(9.5)} />,
  play: openLists,
};

/**
 * Docked to a side, the bar is a column and the list stands beside it,
 * toward the middle of the screen, joined to it the way it joins a row.
 */
export const DockedSides: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Stage call={callAt(9.5)} dock="right" />
      <Stage call={callAt(9.5)} dock="left" />
    </div>
  ),
  play: openLists,
};

function Playing() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => {
      setT(((performance.now() - start) / 1000) % LOOP);
    }, 100);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return <Stage call={callAt(t)} />;
}

/** The script on a loop: two sub-agents and the turn's own tool steps. */
export const OnACall: Story = {
  render: () => <Playing />,
};

/** The count behind each of the four words the bar says. */
export const CountOnEveryPhase: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Stage call={callAt(9)} />
      <Stage call={callAt(13.3)} />
      <Stage call={callAt(5.5)} />
      <Stage call={callAt(7.2)} />
    </div>
  ),
};

const MANY: VoiceActivityWork[] = [
  "Flights to Lisbon",
  "Hotels near Alfama",
  "Email to Bob",
  "Restaurant for Friday",
  "Museum tickets",
  "Train to Sintra",
  "Currency rates",
].map((title, index) => ({
  id: `sub-${index}`,
  kind: "subagent",
  title,
  step: "Searching the web",
  state: "running",
  startedAt: START - index * 20_000,
}));

/** More than the list holds: the rest summed up under it. Press the count. */
export const ManyRunning: Story = {
  render: () => <Stage call={{ ...CALL, work: MANY }} />,
};

/** A session from before the list: the step stays on the line, and no count. */
export const WithoutAWorkList: Story = {
  render: () => (
    <Stage
      call={{
        ...CALL,
        ...PHASES.thinking,
        detail: "Searching the web",
        work: undefined,
      }}
    />
  ),
};
