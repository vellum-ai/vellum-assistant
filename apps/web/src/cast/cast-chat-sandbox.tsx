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
  /** Canned "real signal" line Vela streams once the tool is connected. */
  signal: string;
}

// First PRIMARY_TOOL_COUNT show by default; the rest reveal via "Show more".
const PRIMARY_TOOL_COUNT = 4;

const TOOLS: Tool[] = [
  { id: "google", providerKey: "google", name: "Google", benefit: "Email, calendar, and Drive in one.", signal: "Calendar's in. Monday's stacked — two real conflicts at 12:30 and 2pm." },
  { id: "notion", providerKey: "notion", name: "Notion", benefit: "Docs and projects, work and personal.", signal: "Notion's connected. Found your roadmap and three half-finished specs." },
  { id: "github", providerKey: "github", name: "GitHub", benefit: "Repos, PRs, and reviews.", signal: "GitHub's in. 4 PRs are waiting on your review; one's been open a week." },
  { id: "linear", providerKey: "linear", name: "Linear", benefit: "Issues and cycles — your real workflow.", signal: "Linear's wired up. 7 issues in this cycle, 2 already overdue." },
  { id: "twitter", providerKey: "twitter", name: "Twitter", benefit: "Posts and direct messages.", signal: "Twitter's in. Three DMs unopened — one from someone you follow back." },
  { id: "asana", providerKey: "asana", name: "Asana", benefit: "Tasks and projects.", signal: "Asana's connected. 5 tasks due this week, 2 already late." },
  { id: "discord", providerKey: "discord", name: "Discord", benefit: "Communities, gaming, side projects.", signal: "Discord's connected. Two servers buzzing — someone @'d you in #general." },
  { id: "hubspot", providerKey: "hubspot", name: "HubSpot", benefit: "CRM contacts and deals.", signal: "HubSpot's in. Two deals slipped to next quarter — worth a nudge." },
  { id: "outlook", providerKey: "outlook", name: "Outlook", benefit: "Email and calendar, the Microsoft way.", signal: "Outlook's in. Your week's mapped — a 9am tomorrow you might've forgotten." },
  { id: "todoist", providerKey: "todoist", name: "Todoist", benefit: "Tasks and projects.", signal: "Todoist's connected. 12 tasks overdue — want me to triage?" },
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

// ---------------------------------------------------------------------------
// Scripted lines
// ---------------------------------------------------------------------------

const FIRST_LINE = "The more I see, the more useful I get.\n\nOpen the doors. I'll do the rest.";
// Auto-transition into the "where do you want me" beat after tools resolves.
const TOOLS_TRANSITION = "That's my senses online. One more thing: where do you want me?";
const SKIP_TRANSITION =
  "No rush — we can wire those up later. One more thing: where do you want me?";
const CLOSE_LINE =
  "Okay, I'm set up. I know your role, I've got senses, I can reach you on the go. Let's go.";

// ---------------------------------------------------------------------------
// Conversation entries (messages + inline interactive widgets)
// ---------------------------------------------------------------------------

type Entry =
  | { id: string; kind: "msg"; message: DisplayMessage; turnStart?: boolean }
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
  const [showAll, setShowAll] = useState(false);
  const selected = TOOLS.filter((t) => sel.has(t.id));
  // Show all on resolve so chosen tools beyond the first four stay visible.
  const visible = showAll || resolved ? TOOLS : TOOLS.slice(0, PRIMARY_TOOL_COUNT);

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
          {visible.map((t) => (
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
            </button>
          ))}
        </div>
        {!resolved && TOOLS.length > PRIMARY_TOOL_COUNT && (
          <button
            type="button"
            className="cast-picker__more"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? "Show less" : "Show more"}
          </button>
        )}
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
  const [toolsDone, setToolsDone] = useState(false);
  const [takeDone, setTakeDone] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const connectedRef = useRef(false); // did the tools beat connect anything?
  const takeStartedRef = useRef(false);
  const closedRef = useRef(false);
  const spacerRef = useRef<HTMLDivElement>(null);

  // ---- primitives ----
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  // `turnStart` messages open a new section — they get scrolled to the top of
  // the conversation (real-chat "latest turn pinned to top").
  async function streamAssistant(text: string, turnStart = false) {
    const id = nid();
    setEntries((prev) => [...prev, { id, kind: "msg", message: asstMsg(id, ""), turnStart }]);
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

  // Size the trailing spacer to exactly fill the viewport below the current
  // section (anchor → end): enough for a turn-start message to reach the top,
  // but no extra, so content can't be over-scrolled out of the frame. Returns
  // the section's pixel height.
  function sizeSpacer(): number {
    const sc = scrollRef.current;
    const spacer = spacerRef.current;
    const anchor = anchorRef.current;
    const end = endRef.current;
    if (!sc) return 0;
    const sectionH = anchor && end ? end.offsetTop - anchor.offsetTop : 0;
    if (spacer) spacer.style.minHeight = `${Math.max(0, sc.clientHeight - sectionH)}px`;
    return sectionH;
  }

  // Keep the spacer fitted on resize.
  useEffect(() => {
    const onResize = () => sizeSpacer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Scroll behaviour: a turn-start message pins to the TOP (pushing prior
  // content up). Continuations keep the anchor pinned while the section fits the
  // viewport; once it overflows we follow the bottom so streamed content stays
  // in view.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const sectionH = sizeSpacer();
    const anchor = anchorRef.current;
    const end = endRef.current;
    const last = entries[entries.length - 1];

    if (last && last.kind === "msg" && last.turnStart && anchor) {
      anchor.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (anchor && end && sectionH <= sc.clientHeight) return;
    end?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  // On load: Vela opens, then the integration grid drops in directly below.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      await streamAssistant(FIRST_LINE, true);
      setEntries((prev) => [...prev, { id: nid(), kind: "tools", resolved: false }]);
    })();
    // streamAssistant is a stable scripted helper; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tools resolved → auto-transition message + the handoff tiles. Both done →
  // the close line + Start chatting button. No pills — the flow drives itself.
  useEffect(() => {
    if (toolsDone && takeDone) {
      if (closedRef.current) return;
      closedRef.current = true;
      void (async () => {
        await sleep(BEAT_GAP_MS);
        await streamAssistant(CLOSE_LINE, true);
        setEntries((prev) => [...prev, { id: nid(), kind: "close" }]);
      })();
      return;
    }
    if (toolsDone && !takeStartedRef.current) {
      takeStartedRef.current = true;
      void (async () => {
        await sleep(BEAT_GAP_MS);
        await streamAssistant(connectedRef.current ? TOOLS_TRANSITION : SKIP_TRANSITION, true);
        setEntries((prev) => [...prev, { id: nid(), kind: "take", resolved: false, pickedId: null }]);
      })();
    }
    // Helpers are stable; only the beat flags drive these transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsDone, takeDone]);

  // ---- Connect tools beat ----
  async function finishTools(gridId: string, selected: Tool[]) {
    setEntries((prev) =>
      prev.map((e) => (e.kind === "tools" && e.id === gridId ? { ...e, resolved: true } : e)),
    );
    connectedRef.current = selected.length > 0;
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
        await sleep(BEAT_GAP_MS);
        await streamAssistant(tool.signal);
      }
    }
    setToolsDone(true);
  }

  // ---- Take me with you beat ----
  async function pickTake(tilesId: string, option: TakeOption) {
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === "take" && e.id === tilesId
          ? { ...e, resolved: true, pickedId: option.id }
          : e,
      ),
    );
    await sleep(BEAT_GAP_MS);
    await streamAssistant(option.confirm);
    setTakeDone(true);
  }

  function onStart() {
    // Out of scope — placeholder.
    console.log("[Cast] Start chatting");
  }

  // Three-step progress: role (always done) + the two beats.
  const completed = 1 + (toolsDone ? 1 : 0) + (takeDone ? 1 : 0);

  // Only the last message streams; the avatar rides under the latest reply.
  const lastMsgId = [...entries].reverse().find((e) => e.kind === "msg")?.id;
  const lastReplyId = [...entries]
    .reverse()
    .find((e) => e.kind === "msg" && e.message.role === "assistant")?.id;
  // The latest section-opening message — the one pinned to the top.
  const anchorId = [...entries].reverse().find((e) => e.kind === "msg" && e.turnStart)?.id;

  return (
    // Dark-only, like the rest of Cast — semantic tokens resolve to dark here.
    <div className="cast-stage" data-theme="dark">
      <div className="cast-panel cast-focus">
        <header className="cast-focus__header">
          <h1 className="cast-focus__title">Show me around</h1>
          {/* Thin progress: one dot per step (role + 2 beats), spread wide. */}
          <div className="cast-focus__progress" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className={`cast-focus__pdot${i < completed ? " is-on" : ""}`} />
            ))}
          </div>
        </header>

        <div className="cast-focus__scroll" ref={scrollRef}>
          <div className="cast-focus__col">
            {entries.map((e) => {
              if (e.kind === "msg") {
                return (
                  <div
                    className="cast-focus__turn"
                    key={e.id}
                    ref={e.id === anchorId ? anchorRef : undefined}
                  >
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
            {/* Presenter rides under the whole latest response block, left-aligned. */}
            {lastReplyId && (
              <div className="cast-focus__presenter" aria-hidden>
                <CastAvatar character={LIL_DUDE} />
              </div>
            )}
            {/* End of real content — "follow the bottom" targets this, above the
                spacer, so streamed continuations stay in view. */}
            <div ref={endRef} />
            {/* Spacer (height set imperatively) lets a turn-start message reach
                the top without letting content over-scroll out of the frame. */}
            <div className="cast-focus__spacer" ref={spacerRef} aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
