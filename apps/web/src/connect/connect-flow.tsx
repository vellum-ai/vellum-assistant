import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { CheckCircle2, ChevronDown, Loader2, Send, Smartphone } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { defaultManagedOAuthConnectClient } from "@/domains/chat/api/managed-oauth";
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

type ConnectStatus = "connecting" | "connected" | "skipped";

type Entry =
  | { id: string; kind: "msg"; message: DisplayMessage; turnStart?: boolean }
  | { id: string; kind: "tools"; resolved: boolean }
  // `auto` (single selection) drives the real OAuth popup itself; otherwise the
  // user connects each via the real OAuthConnectSurface card.
  | { id: string; kind: "connect"; auto: boolean; tools: Tool[]; status: Record<string, ConnectStatus> }
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
}: {
  resolved: boolean;
  onContinue: (tools: Tool[]) => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const selected = TOOLS.filter((t) => sel.has(t.id));
  // Keep the grid at whatever was shown when Continue was clicked (don't expand
  // on resolve).
  const visible = showAll ? TOOLS : TOOLS.slice(0, PRIMARY_TOOL_COUNT);

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
          aria-label={showAll ? "Show less" : "Show more"}
          className="flex items-center justify-center self-center rounded-md p-1 text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
          onClick={() => setShowAll((s) => !s)}
        >
          <ChevronDown size={18} className={`transition-transform ${showAll ? "rotate-180" : ""}`} />
        </button>
      )}

      {!resolved && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="regular"
            disabled={selected.length === 0}
            className="disabled:!bg-[var(--surface-active)] disabled:!text-[var(--content-tertiary)]"
            onClick={() => onContinue(selected)}
          >
            {`Continue${selected.length ? ` · ${selected.length}` : ""}`}
          </Button>
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

/** Read-only status card for the single-select auto-connect (the OAuth popup
 *  is driven directly, so there's no "Connect" button to click). */
function ConnectStatusCard({ tool, status }: { tool: Tool; status: ConnectStatus }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-4">
      <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]">
        <IntegrationIcon providerKey={tool.providerKey} displayName={tool.name} logoUrl={null} size={26} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-body-medium-default text-[var(--content-default)]">Connect {tool.name}</div>
        <div className="text-body-small-default text-[var(--content-tertiary)]">{tool.benefit}</div>
      </div>
      <div className="flex flex-none items-center gap-1.5 text-body-small-default">
        {status === "connecting" && (
          <>
            <Loader2 size={15} className="animate-spin text-[var(--content-secondary)]" />
            <span className="text-[var(--content-secondary)]">Connecting…</span>
          </>
        )}
        {status === "connected" && (
          <>
            <CheckCircle2 size={15} className="text-[var(--system-positive-strong)]" />
            <span className="text-[var(--system-positive-strong)]">Connected</span>
          </>
        )}
        {status === "skipped" && <span className="text-[var(--content-tertiary)]">Skipped</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function ConnectFlow() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [toolsDone, setToolsDone] = useState(false);
  const [takeDone, setTakeDone] = useState(false);

  // Real connect needs a signed-in user (this route is authed) + a selected
  // assistant. Nullable — the card honestly shows its "missing" state if absent.
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const startedRef = useRef(false);
  const connectedRef = useRef(false);
  const takeStartedRef = useRef(false);
  const closedRef = useRef(false);

  // Progress bar tracks ~2/3 of the (responsive) title width.
  const [progressW, setProgressW] = useState(0);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const measure = () => setProgressW(Math.round(el.getBoundingClientRect().width * 0.66));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  }, [entries]);

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
  function setConnectStatus(connectId: string, toolId: string, status: ConnectStatus): boolean {
    let allResolved = false;
    setEntries((prev) =>
      prev.map((e) => {
        if (e.kind !== "connect" || e.id !== connectId) return e;
        const next = { ...e.status, [toolId]: status };
        allResolved = e.tools.every((t) => next[t.id] && next[t.id] !== "connecting");
        return { ...e, status: next };
      }),
    );
    return allResolved;
  }

  // Grid Continue: lock the grid (no expand), then drive the real connect.
  function finishToolsGrid(gridId: string, selected: Tool[]) {
    setEntries((prev) =>
      prev.map((e) => (e.kind === "tools" && e.id === gridId ? { ...e, resolved: true } : e)),
    );
    if (selected.length === 0) {
      setToolsDone(true);
      return;
    }
    // A single pick auto-starts its OAuth popup (kept inside this click gesture);
    // multiple picks each connect via their card.
    if (selected.length === 1 && assistantId) {
      autoConnectSingle(selected[0], assistantId);
    } else {
      void startCardConnect(selected);
    }
  }

  // Single selection: open the real OAuth popup immediately (no extra click),
  // react on success, and auto-advance once it closes (connected or cancelled).
  function autoConnectSingle(tool: Tool, aid: string) {
    const promise = defaultManagedOAuthConnectClient.connect({
      assistantId: aid,
      providerKey: tool.providerKey,
      providerLabel: tool.name,
    });
    const cid = nid();
    setEntries((prev) => [
      ...prev,
      { id: cid, kind: "connect", auto: true, tools: [tool], status: { [tool.id]: "connecting" } },
    ]);
    void (async () => {
      const result = await promise;
      const ok = result.status === "connected";
      setConnectStatus(cid, tool.id, ok ? "connected" : "skipped");
      if (ok) {
        connectedRef.current = true;
        await streamAssistant(tool.signal);
      }
      finishConnect();
    })();
  }

  // Multiple selections: a real connect card per tool. Each "connect"/"cancel"
  // resolves that tool; once all are resolved we auto-advance.
  async function startCardConnect(selected: Tool[]) {
    await streamAssistant(CONNECT_INTRO);
    setEntries((prev) => [
      ...prev,
      { id: nid(), kind: "connect", auto: false, tools: selected, status: {} },
    ]);
  }

  function onCardAction(connectId: string, tool: Tool, actionId: string) {
    const ok = actionId === "connect";
    const allResolved = setConnectStatus(connectId, tool.id, ok ? "connected" : "skipped");
    if (ok) {
      connectedRef.current = true;
      void streamAssistant(tool.signal);
    }
    if (allResolved) finishConnect();
  }

  // Auto-advance past the connect step.
  function finishConnect() {
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
        <h1
          ref={titleRef}
          className="text-3xl font-semibold tracking-tight text-[var(--content-default)]"
        >
          Show me around
        </h1>
        <div className="flex items-center gap-2" style={{ width: progressW || undefined }}>
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
                />
              );
            }
            if (e.kind === "connect") {
              if (e.auto) {
                const tool = e.tools[0];
                return (
                  <div key={e.id}>
                    <ConnectStatusCard tool={tool} status={e.status[tool.id] ?? "connecting"} />
                  </div>
                );
              }
              return (
                <div key={e.id} className="flex flex-col gap-2.5">
                  {e.tools.map((tool) => (
                    <OAuthConnectSurface
                      key={tool.id}
                      surface={surfaceForTool(tool)}
                      assistantId={assistantId}
                      assistantDisplayName={ASSISTANT_NAME}
                      onAction={(_sid, actionId) => onCardAction(e.id, tool, actionId)}
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

          <div ref={endRef} />
          <div ref={spacerRef} aria-hidden />
        </div>
      </div>
    </div>
  );
}
