import { memo, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Send, Smartphone } from "lucide-react";

import { CastAvatar } from "@/cast/cast-avatar";
import { buildCharacter } from "@/cast/cast-roster";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import type { DisplayMessage } from "@/domains/chat/types/types";
import "@/cast/cast.css";

/**
 * Standalone onboarding chat in "focus mode": the REAL conversation UI
 * (`TranscriptMessageBody` for every turn, in the product's centered
 * `--chat-max-width` column) with the app chrome stripped. Title up top, a
 * "lil dude" character under the latest reply, and the journey pills pinned to
 * the bottom — the pills are the only input until an inline grid appears.
 *
 * Fully scripted: every assistant line is canned and fake-streamed (no model
 * calls), and the tool/handoff connections are SIMULATED (no real OAuth) so the
 * whole beat sequence plays as a self-contained demo. Mounted at
 * `/assistant/focus-chat`.
 */

const ASSISTANT_NAME = "Vela";
// The "lil dude": a static composed avatar from the real vocabulary.
const LIL_DUDE = buildCharacter("flower", "quirky", "orange");
const noop = () => {};

// Fake-stream cadence + simulated-connect timing.
const TTFT_MS = 340;
const STEP_MS = 46;
const CONNECT_MS = 1100;
const BEAT_GAP_MS = 260;

let uid = 0;
const nid = () => `cast-e${++uid}`;

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Scripted data
// ---------------------------------------------------------------------------

interface Tool {
  id: string;
  providerKey: string;
  name: string;
  benefit: string;
  reward: number;
  /** Canned "real signal" line Vela streams once the tool is connected. */
  signal: string;
}

const TOOLS: Tool[] = [
  { id: "google", providerKey: "google", name: "Google", benefit: "Calendar + Gmail, always in view", reward: 5, signal: "Calendar's in. Monday's stacked — two real conflicts at 12:30 and 2pm." },
  { id: "notion", providerKey: "notion", name: "Notion", benefit: "Docs and specs, searchable", reward: 5, signal: "Notion's connected. Found your roadmap and three half-finished specs." },
  { id: "linear", providerKey: "linear", name: "Linear", benefit: "Issues and cycles I can track", reward: 5, signal: "Linear's wired up. 7 issues in this cycle, 2 already overdue." },
  { id: "drive", providerKey: "drive", name: "Drive", benefit: "Files and folders on tap", reward: 5, signal: "Drive's connected. Your shared folders are in — that deck from Friday is the latest." },
  { id: "github", providerKey: "github", name: "GitHub", benefit: "Repos, PRs, and reviews", reward: 5, signal: "GitHub's in. 4 PRs are waiting on your review; one's been open a week." },
  { id: "slack", providerKey: "slack", name: "Slack", benefit: "Threads and DMs that matter", reward: 5, signal: "Slack's connected. Two threads pinged you directly this morning." },
];

interface TakeOption {
  id: string;
  icon: "phone" | "telegram";
  name: string;
  benefit: string;
  reward: number;
  /** Canned confirmation Vela streams after the (simulated) connection. */
  confirm: string;
}

const TAKE: TakeOption[] = [
  { id: "ios", icon: "phone", name: "Put me on your phone", benefit: "Push, biometrics, home-screen tap", reward: 65, confirm: "You're on the App Store — once I'm installed I'll be a tap away on your home screen." },
  { id: "telegram", icon: "telegram", name: "Bring me to Telegram", benefit: "Reach me from any chat", reward: 65, confirm: "Telegram's linked. Message me there and I'll answer like I'm right here." },
];

const TOTAL_CREDITS = 100;

// ---------------------------------------------------------------------------
// Conversation entries (messages + inline interactive widgets)
// ---------------------------------------------------------------------------

type Entry =
  | { id: string; kind: "msg"; message: DisplayMessage }
  | { id: string; kind: "tools"; resolved: boolean }
  | { id: string; kind: "connect"; tool: Tool; state: "connecting" | "connected" }
  | { id: string; kind: "take"; resolved: boolean; pickedId: string | null }
  | { id: string; kind: "close" };

function asstMsg(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    timestamp: now(),
  };
}

function userMsg(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "user",
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    timestamp: now(),
  };
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

/** One turn through the real chat component — user or assistant. */
const FocusRow = memo(function FocusRow({
  message,
  isStreaming,
}: {
  message: DisplayMessage;
  isStreaming: boolean;
}) {
  const [expandedToolCallIds] = useState(() => new Set<string>());
  const [expandedCardIds] = useState(() => new Map<string, boolean>());
  const [expandedThinkingKeys] = useState(() => new Map<string, boolean>());
  return (
    <TranscriptMessageBody
      message={message}
      assistantDisplayName={ASSISTANT_NAME}
      expandedToolCallIds={expandedToolCallIds}
      expandedCardIds={expandedCardIds}
      expandedThinkingKeys={expandedThinkingKeys}
      onSurfaceAction={noop}
      isStreaming={isStreaming}
    />
  );
});

/** Simulated connect card — drops in already connecting, flips to connected. */
function SimConnectCard({ tool, state }: { tool: Tool; state: "connecting" | "connected" }) {
  return (
    <div className="cast-sim-card">
      <div className="cast-sim-card__icon">
        <IntegrationIcon providerKey={tool.providerKey} displayName={tool.name} logoUrl={null} size={26} />
      </div>
      <div className="cast-sim-card__body">
        <div className="cast-sim-card__title">Connect {tool.name}</div>
        <div className="cast-sim-card__desc">{tool.benefit}</div>
      </div>
      <div className={`cast-sim-card__status is-${state}`}>
        {state === "connecting" ? (
          <>
            <Loader2 size={15} className="animate-spin" /> Connecting…
          </>
        ) : (
          <>
            <CheckCircle2 size={15} /> Connected
          </>
        )}
      </div>
    </div>
  );
}

/** Multi-select grid of tools (Connect tools beat). */
function ToolGrid({
  resolved,
  onContinue,
  onSkip,
}: {
  resolved: boolean;
  onContinue: (tools: Tool[]) => void;
  onSkip: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const selected = TOOLS.filter((t) => sel.has(t.id));

  function toggle(id: string) {
    if (resolved) return;
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="cast-focus__turn cast-block">
      <div className="cast-picker">
        <div className="cast-grid">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`cast-tile${sel.has(t.id) ? " is-selected" : ""}`}
              disabled={resolved}
              onClick={() => toggle(t.id)}
            >
              <span className="cast-tile__icon">
                <IntegrationIcon providerKey={t.providerKey} displayName={t.name} logoUrl={null} size={28} />
              </span>
              <span className="cast-tile__text">
                <span className="cast-tile__name">{t.name}</span>
                <span className="cast-tile__benefit">{t.benefit}</span>
              </span>
              <span className="cast-tile__reward">+{t.reward}</span>
            </button>
          ))}
        </div>
        {!resolved && (
          <div className="cast-picker__actions">
            <button
              type="button"
              className="cast-picker__continue"
              disabled={selected.length === 0}
              onClick={() => onContinue(selected)}
            >
              {`Continue${selected.length ? ` · ${selected.length}` : ""}`}
            </button>
            {selected.length === 0 && (
              <button type="button" className="cast-picker__skip" onClick={onSkip}>
                Skip for now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Two handoff tiles (Take me with you beat) — pick one. */
function TakeTiles({
  resolved,
  pickedId,
  onPick,
}: {
  resolved: boolean;
  pickedId: string | null;
  onPick: (option: TakeOption) => void;
}) {
  return (
    <div className="cast-focus__turn cast-block">
      <div className="cast-grid">
        {TAKE.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`cast-tile${pickedId === o.id ? " is-selected" : ""}`}
            disabled={resolved}
            onClick={() => onPick(o)}
          >
            <span className="cast-tile__icon">
              {o.icon === "phone" ? <Smartphone size={24} /> : <Send size={24} />}
            </span>
            <span className="cast-tile__text">
              <span className="cast-tile__name">{o.name}</span>
              <span className="cast-tile__benefit">{o.benefit}</span>
            </span>
            <span className="cast-tile__reward">+{o.reward}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function CastChatSandbox() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [beat, setBeat] = useState<"idle" | "tools" | "take">("idle");
  const [toolsDone, setToolsDone] = useState(false);
  const [takeDone, setTakeDone] = useState(false);
  const [earned, setEarned] = useState(5); // "Pick a role" is pre-completed

  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const closedRef = useRef(false);

  // ---- primitives ----
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  // Seed an opening line once.
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const id = nid();
    setEntries([
      {
        id,
        kind: "msg",
        message: asstMsg(
          id,
          "Hey — I'm Vela. Two quick things and I'm ready to work. Use the pills below.",
        ),
      },
    ]);
  }, []);

  // Keep the latest turn in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  // Once both beats resolve, play the closing line + Start chatting button.
  useEffect(() => {
    if (!toolsDone || !takeDone || closedRef.current) return;
    closedRef.current = true;
    void (async () => {
      await sleep(BEAT_GAP_MS);
      await streamAssistant(
        "Okay, I'm set up. I know your role, I've got senses, I can reach you on the go. Let's go.",
      );
      setEntries((prev) => [...prev, { id: nid(), kind: "close" }]);
    })();
    // streamAssistant/sleep are stable scripted helpers; only the beat flags matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsDone, takeDone]);

  function pushUser(text: string) {
    const id = nid();
    setEntries((prev) => [...prev, { id, kind: "msg", message: userMsg(id, text) }]);
  }

  async function streamAssistant(text: string) {
    const id = nid();
    setEntries((prev) => [...prev, { id, kind: "msg", message: asstMsg(id, "") }]);
    setStreaming(true);
    await sleep(TTFT_MS);
    const words = text.split(" ");
    for (let w = 2; ; w += 2) {
      const partial = words.slice(0, w).join(" ");
      setEntries((prev) =>
        prev.map((e) =>
          e.kind === "msg" && e.id === id
            ? { ...e, message: { ...e.message, textSegments: [partial] } }
            : e,
        ),
      );
      if (w >= words.length) break;
      await sleep(STEP_MS);
    }
    setStreaming(false);
  }

  // ---- Connect tools beat ----
  async function startTools() {
    if (beat !== "idle" || streaming || toolsDone) return;
    setBeat("tools");
    pushUser("Connect me to the outside world.");
    await streamAssistant(
      "I do my best work when I'm connected to the tools you use. Pick whichever you want.",
    );
    setEntries((prev) => [...prev, { id: nid(), kind: "tools", resolved: false }]);
  }

  async function finishTools(gridId: string, selected: Tool[]) {
    setEntries((prev) =>
      prev.map((e) => (e.kind === "tools" && e.id === gridId ? { ...e, resolved: true } : e)),
    );
    if (selected.length === 0) {
      await streamAssistant("Going in light. You can hook me up later.");
    } else {
      for (const tool of selected) {
        await streamAssistant(`Hooking up ${tool.name}.`);
        const cardId = nid();
        setEntries((prev) => [...prev, { id: cardId, kind: "connect", tool, state: "connecting" }]);
        await sleep(CONNECT_MS);
        setEntries((prev) =>
          prev.map((e) =>
            e.kind === "connect" && e.id === cardId ? { ...e, state: "connected" } : e,
          ),
        );
        setEarned((c) => c + tool.reward);
        await sleep(BEAT_GAP_MS);
        await streamAssistant(tool.signal);
      }
    }
    setToolsDone(true);
    setBeat("idle");
  }

  // ---- Take me with you beat ----
  async function startTake() {
    if (beat !== "idle" || streaming || takeDone) return;
    setBeat("take");
    pushUser("Take me with you.");
    await streamAssistant("Good. I want to be where you are. Pick a way.");
    setEntries((prev) => [...prev, { id: nid(), kind: "take", resolved: false, pickedId: null }]);
  }

  async function pickTake(tilesId: string, option: TakeOption) {
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === "take" && e.id === tilesId
          ? { ...e, resolved: true, pickedId: option.id }
          : e,
      ),
    );
    setEarned((c) => c + option.reward);
    await sleep(BEAT_GAP_MS);
    await streamAssistant(option.confirm);
    setTakeDone(true);
    setBeat("idle");
  }

  function onStart() {
    // Out of scope — placeholder.
    console.log("[Cast] Start chatting");
  }

  const pills = [
    { label: "Pick a role", credits: 5, done: true, disabled: true, onClick: noop },
    {
      label: "Connect tools",
      credits: 30,
      done: toolsDone,
      disabled: toolsDone || beat !== "idle" || streaming,
      onClick: startTools,
    },
    {
      label: "Take me with you",
      credits: 65,
      done: takeDone,
      disabled: takeDone || beat !== "idle" || streaming,
      onClick: startTake,
    },
  ];

  // Avatar rides under the most recent assistant reply.
  const lastMsgId = [...entries].reverse().find((e) => e.kind === "msg")?.id;
  const lastEntry = entries[entries.length - 1];
  const showAvatar = lastEntry?.kind === "msg" && lastEntry.message.role === "assistant";

  return (
    // Dark-only, like the rest of Cast — semantic tokens resolve to dark here.
    <div className="cast-stage" data-theme="dark">
      <div className="cast-panel cast-focus">
        <header className="cast-focus__header">
          <h1 className="cast-focus__title">Help me be the best</h1>
        </header>

        <div className="cast-focus__scroll">
          <div className="cast-focus__col">
            {entries.map((e) => {
              if (e.kind === "msg") {
                return (
                  <div className="cast-focus__turn" key={e.id}>
                    <FocusRow message={e.message} isStreaming={streaming && e.id === lastMsgId} />
                  </div>
                );
              }
              if (e.kind === "tools") {
                return (
                  <ToolGrid
                    key={e.id}
                    resolved={e.resolved}
                    onContinue={(sel) => finishTools(e.id, sel)}
                    onSkip={() => finishTools(e.id, [])}
                  />
                );
              }
              if (e.kind === "connect") {
                return (
                  <div className="cast-focus__turn cast-focus__surface" key={e.id}>
                    <SimConnectCard tool={e.tool} state={e.state} />
                  </div>
                );
              }
              if (e.kind === "take") {
                return (
                  <TakeTiles
                    key={e.id}
                    resolved={e.resolved}
                    pickedId={e.pickedId}
                    onPick={(o) => pickTake(e.id, o)}
                  />
                );
              }
              // close
              return (
                <div className="cast-focus__turn cast-block" key={e.id}>
                  <button type="button" className="cast-close__btn" onClick={onStart}>
                    Start chatting
                  </button>
                </div>
              );
            })}
            {showAvatar && (
              <div className="cast-focus__avatar" aria-hidden>
                <CastAvatar character={LIL_DUDE} />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <footer className="cast-focus__footer">
          <div className="cast-focus__journey">
            {pills.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`cast-focus__step${p.done ? " is-done" : ""}`}
                disabled={p.disabled}
                onClick={p.onClick}
              >
                <span className="cast-focus__step-dot">{p.done ? "✓" : ""}</span>
                <span className="cast-focus__step-label">{p.label}</span>
                <span className="cast-focus__step-credits">+{p.credits}</span>
              </button>
            ))}
            <span className="cast-focus__credits">
              {earned}/{TOTAL_CREDITS} credits
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
