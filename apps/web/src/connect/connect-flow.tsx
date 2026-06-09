import { memo, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Send, Smartphone } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import { openIOSAppStore } from "@/hooks/use-ios-app-nudge";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/**
 * "Show me around" — an authed, chat-style onboarding surface that connects the
 * user's tools and offers a mobile/Telegram handoff. Built with the app's own
 * design-library + semantic tokens (no bespoke CSS) and the REAL managed-OAuth
 * connect flow (`OAuthConnectSurface` + the production client). The conversation
 * is otherwise canned + fake-streamed (no model calls); the post-connect
 * "signal" reactions and the handoff beat are scripted. Mounted at
 * `/assistant/connect`.
 */

const ASSISTANT_NAME = "Vela";

// The presenting character — a static composed avatar from the real vocabulary.
const DUDE_SVG = composeSvg(BUNDLED_COMPONENTS, "flower", "quirky", "orange", 240);

// Fake-stream cadence.
const TTFT_MS = 340;
const STEP_MS = 46;
const BEAT_GAP_MS = 260;

let uid = 0;
const nid = () => `connect-e${++uid}`;
const now = () => Date.now();

// ---------------------------------------------------------------------------
// Scripted data
// ---------------------------------------------------------------------------

interface Tool {
  id: string;
  providerKey: string;
  name: string;
  benefit: string;
  /** Canned "real signal" line Vela streams once the tool connects. */
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
  confirm: string;
}

const TAKE: TakeOption[] = [
  { id: "ios", icon: "phone", name: "Put me on your phone", benefit: "Push, biometrics, home-screen tap", confirm: "You're on the App Store — once I'm installed I'll be a tap away on your home screen." },
  { id: "telegram", icon: "telegram", name: "Bring me to Telegram", benefit: "Reach me from any chat", confirm: "Telegram's linked. Message me there and I'll answer like I'm right here." },
];

const FIRST_LINE = "The more I see, the more useful I get.\n\nOpen the doors. I'll do the rest.";
const CONNECT_INTRO = "On it — connect what you want and I'll get straight to work.";
const TOOLS_TRANSITION = "That's my senses online. One more thing: where do you want me?";
const SKIP_TRANSITION = "No rush — we can wire those up later. One more thing: where do you want me?";
const CLOSE_LINE =
  "Okay, I'm set up. I know your role, I've got senses, I can reach you on the go. Let's go.";

/** Build the transcript surface the real OAuth connect card reads. */
function surfaceForTool(tool: Tool): Surface {
  return {
    surfaceId: `connect-${tool.id}`,
    surfaceType: "oauth_connect",
    title: `Connect ${tool.name}`,
    data: {
      providerKey: tool.providerKey,
      displayName: tool.name,
      description: tool.benefit,
      logoUrl: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation entries
// ---------------------------------------------------------------------------

type Entry =
  | { id: string; kind: "msg"; message: DisplayMessage; turnStart?: boolean }
  | { id: string; kind: "tools"; resolved: boolean }
  | { id: string; kind: "connect"; tools: Tool[]; connected: Record<string, boolean> }
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

const noop = () => {};

/** A message rendered through the real chat component (hover action bar hidden
 *  via the descendant selector on the column). */
const MessageRow = memo(function MessageRow({
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
    <div className="flex flex-col gap-2">
      <TranscriptMessageBody
        message={message}
        assistantDisplayName={ASSISTANT_NAME}
        expandedToolCallIds={expandedToolCallIds}
        expandedCardIds={expandedCardIds}
        expandedThinkingKeys={expandedThinkingKeys}
        onSurfaceAction={noop}
        isStreaming={isStreaming}
      />
    </div>
  );
});

const tileClass = (selected: boolean, dimmed: boolean) =>
  [
    "flex items-start gap-3 rounded-lg border p-3.5 text-left transition-colors",
    "bg-[var(--surface-lift)] hover:bg-[var(--surface-active)] disabled:cursor-default",
    selected
      ? "border-[var(--primary-base)] ring-1 ring-[var(--primary-base)]"
      : "border-[var(--border-subtle)]",
    dimmed ? "opacity-50" : "",
  ].join(" ");

/** Multi-select tool grid with a "Show more" expander. */
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
    <div className="flex flex-col gap-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3.5">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {visible.map((t) => {
          const isSelected = sel.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              className={tileClass(isSelected, resolved && !isSelected)}
              disabled={resolved}
              onClick={() => toggle(t.id)}
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center">
                <IntegrationIcon providerKey={t.providerKey} displayName={t.name} logoUrl={null} size={28} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-medium-default text-[var(--content-default)]">{t.name}</span>
                <span className="text-body-small-default text-[var(--content-tertiary)]">{t.benefit}</span>
              </span>
            </button>
          );
        })}
      </div>

      {!resolved && TOOLS.length > PRIMARY_TOOL_COUNT && (
        <button
          type="button"
          className="self-center text-body-small-default text-[var(--content-secondary)] hover:text-[var(--content-default)]"
          onClick={() => setShowAll((s) => !s)}
        >
          {showAll ? "Show less" : "Show more"}
        </button>
      )}

      {!resolved && (
        <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] pt-3.5">
          <Button
            variant="primary"
            size="regular"
            disabled={selected.length === 0}
            onClick={() => onContinue(selected)}
          >
            {`Continue${selected.length ? ` · ${selected.length}` : ""}`}
          </Button>
          {selected.length === 0 && (
            <Button variant="ghost" size="regular" onClick={onSkip}>
              Skip for now
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Two handoff tiles — pick one. */
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
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {TAKE.map((o) => {
        const isSelected = pickedId === o.id;
        return (
          <button
            key={o.id}
            type="button"
            className={tileClass(isSelected, resolved && !isSelected)}
            disabled={resolved}
            onClick={() => onPick(o)}
          >
            <span className="flex h-8 w-8 flex-none items-center justify-center text-[var(--content-secondary)]">
              {o.icon === "phone" ? <Smartphone size={22} /> : <Send size={22} />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body-medium-default text-[var(--content-default)]">{o.name}</span>
              <span className="text-body-small-default text-[var(--content-tertiary)]">{o.benefit}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function ConnectFlow() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [toolsDone, setToolsDone] = useState(false);
  const [takeDone, setTakeDone] = useState(false);

  // Real connect needs a signed-in user (this route is authed) + a selected
  // assistant. Nullable — the card honestly shows its "missing" state if absent.
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const connectedRef = useRef(false);
  const takeStartedRef = useRef(false);
  const closedRef = useRef(false);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  // turnStart messages open a new section and get pinned to the top.
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

  // ---- scroll: pin a turn-start to the top, follow the bottom otherwise ----
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

  useEffect(() => {
    const onResize = () => sizeSpacer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
  }, [entries, connecting]);

  // ---- flow ----

  // On load: Vela opens, then the tool grid drops in directly below.
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

  // Tools resolved → auto-transition + handoff tiles. Both done → close.
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
    // Helpers are stable scripted closures; only the beat flags drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsDone, takeDone]);

  // Grid Continue: lock it, then drop the real connect cards. Skip: straight on.
  async function finishToolsGrid(gridId: string, selected: Tool[]) {
    setEntries((prev) =>
      prev.map((e) => (e.kind === "tools" && e.id === gridId ? { ...e, resolved: true } : e)),
    );
    if (selected.length === 0) {
      setToolsDone(true);
      return;
    }
    setConnecting(true);
    await streamAssistant(CONNECT_INTRO);
    setEntries((prev) => [
      ...prev,
      { id: nid(), kind: "connect", tools: selected, connected: {} },
    ]);
  }

  // A real OAuth connect succeeded: react with the tool's signal line, and
  // auto-advance once every selected tool in the block is connected.
  async function onToolConnected(connectId: string, tool: Tool) {
    connectedRef.current = true;
    let allConnected = false;
    setEntries((prev) =>
      prev.map((e) => {
        if (e.kind !== "connect" || e.id !== connectId) return e;
        const connected = { ...e.connected, [tool.id]: true };
        allConnected = e.tools.every((t) => connected[t.id]);
        return { ...e, connected };
      }),
    );
    await streamAssistant(tool.signal);
    if (allConnected) finishConnect();
  }

  // Advance past the connect step (manually or once all are connected).
  function finishConnect() {
    setConnecting(false);
    setToolsDone(true);
  }

  async function pickTake(tilesId: string, option: TakeOption) {
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === "take" && e.id === tilesId
          ? { ...e, resolved: true, pickedId: option.id }
          : e,
      ),
    );
    if (option.id === "ios") openIOSAppStore();
    await sleep(BEAT_GAP_MS);
    await streamAssistant(option.confirm);
    setTakeDone(true);
  }

  function onStart() {
    // Out of scope — placeholder.
    console.log("[Connect] Start chatting");
  }

  const completed = 1 + (toolsDone ? 1 : 0) + (takeDone ? 1 : 0);
  const lastMsgId = [...entries].reverse().find((e) => e.kind === "msg")?.id;
  const lastReplyId = [...entries]
    .reverse()
    .find((e) => e.kind === "msg" && e.message.role === "assistant")?.id;
  const anchorId = [...entries].reverse().find((e) => e.kind === "msg" && e.turnStart)?.id;

  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-[var(--surface-base)] text-[var(--content-default)]">
      <header className="flex flex-none flex-col items-center gap-4 px-6 pb-5 pt-7">
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--content-default)]">
          Show me around
        </h1>
        <div className="flex items-center gap-2" style={{ width: "clamp(200px, 26vw, 320px)" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full ${
                i < completed ? "bg-[var(--system-positive-strong)]" : "bg-[var(--surface-active)]"
              }`}
            />
          ))}
        </div>
      </header>

      <div ref={scrollRef} className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <div className="flex w-full max-w-[var(--chat-max-width)] flex-col gap-8 px-4 pb-16 pt-5 sm:px-6 [&_.h-6.opacity-0]:hidden">
          {entries.map((e) => {
            if (e.kind === "msg") {
              return (
                <div key={e.id} ref={e.id === anchorId ? anchorRef : undefined}>
                  <MessageRow message={e.message} isStreaming={streaming && e.id === lastMsgId} />
                </div>
              );
            }
            if (e.kind === "tools") {
              return (
                <ToolGrid
                  key={e.id}
                  resolved={e.resolved}
                  onContinue={(sel) => finishToolsGrid(e.id, sel)}
                  onSkip={() => finishToolsGrid(e.id, [])}
                />
              );
            }
            if (e.kind === "connect") {
              return (
                <div key={e.id} className="flex flex-col gap-2.5">
                  {e.tools.map((tool) => (
                    <OAuthConnectSurface
                      key={tool.id}
                      surface={surfaceForTool(tool)}
                      assistantId={assistantId}
                      assistantDisplayName={ASSISTANT_NAME}
                      onAction={(_sid, actionId) => {
                        if (actionId === "connect") void onToolConnected(e.id, tool);
                      }}
                    />
                  ))}
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
              <div key={e.id} className="flex">
                <Button variant="primary" size="regular" onClick={onStart}>
                  Start chatting
                </Button>
              </div>
            );
          })}

          {/* Presenter bobs under the latest reply, left-aligned. */}
          {lastReplyId && (
            <motion.div
              aria-hidden
              className="h-12 w-12 self-start [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&>svg]:overflow-visible"
              animate={{ y: [0, -4, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              dangerouslySetInnerHTML={{ __html: DUDE_SVG }}
            />
          )}

          {/* Advance past the connect step (also auto-advances once all connect). */}
          {connecting && (
            <div className="flex self-start">
              <Button variant="primary" size="regular" onClick={finishConnect}>
                Continue
              </Button>
            </div>
          )}

          <div ref={endRef} />
          <div ref={spacerRef} aria-hidden />
        </div>
      </div>
    </div>
  );
}
