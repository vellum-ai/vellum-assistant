import { useEffect, useRef, useState } from "react";

import {
  assembleJobMessage,
  assembleRatherMessage,
  EDGES,
  RATHERS,
  type Edge,
  type JobKey,
  type RatherKey,
} from "@/cast/cast-content";
import { type MimeState, type Rect } from "@/cast/cast-hero";
import {
  kickoffJobContext,
  kickoffRatherContext,
  type StyleProfile,
} from "@/cast/cast-hooks";
import { CastChat } from "@/cast/cast-chat";
import { CastConversationView, useCastConversation } from "@/cast/cast-conversation";
import { CastJob } from "@/cast/cast-job";
import { CastProof } from "@/cast/cast-proof-view";
import { CastRather } from "@/cast/cast-rather";
import { CastStarter, type StarterResume } from "@/cast/cast-starter";
import { CastStyle } from "@/cast/cast-style";
import { jobTurn, ratherTurn, styleTurn } from "@/cast/cast-templates";
import { CastTwoPanel } from "@/cast/cast-two-panel";
import type { CastCharacter } from "@/cast/cast-roster";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import "@/cast/cast.css";

type Phase = "starter" | "job" | "rather" | "style" | "done" | "chat" | "boost";

/** Hero box for the composing beats: small, near the top of the LEFT panel. */
function topBoxFor(w: number, h: number): Rect {
  const size = Math.max(120, Math.min(176, Math.min(w, h) * 0.2));
  return { left: w / 2 - size / 2, top: h * 0.05, size };
}

const win = () => ({
  w: typeof window === "undefined" ? 1280 : window.innerWidth,
  h: typeof window === "undefined" ? 900 : window.innerHeight,
});

export function CastPage() {
  const panelRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("starter");
  const [selected, setSelected] = useState<CastCharacter | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const [boxes, setBoxes] = useState(() => {
    const { w, h } = win();
    return { top: topBoxFor(w, h), w };
  });

  // The live (mocked) conversation shown in the right panel of every beat.
  const convo = useCastConversation();
  // Picks (persisted in component state for later beats).
  const [jobs, setJobs] = useState<JobKey[]>([]); // multi-select
  const [jobEdges, setJobEdges] = useState<Record<string, Edge>>({});
  const [rathers, setRathers] = useState<RatherKey[]>([]); // multi-select
  const [style, setStyle] = useState<StyleProfile>({});
  const [mime, setMime] = useState<MimeState | null>(null);
  // Flips true once a rather message is Sent, so the conversation panel can
  // show the "boring stuff" offer after that turn finishes streaming.
  const [ratherSent, setRatherSent] = useState(false);
  const tapRef = useRef(0);
  const mimeTimer = useRef<number | undefined>(undefined);
  const clearBeatTimers = () => {
    clearTimeout(mimeTimer.current);
  };

  useEffect(() => {
    const onResize = () => {
      const { w, h } = win();
      setBoxes({ top: topBoxFor(w, h), w });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearBeatTimers();
    };
  }, []);

  const name = selected ? (names[selected.id] ?? selected.name) : "";
  // Hero box centered in the LEFT half for the two-panel composing beats.
  const leftPanelBox: Rect = { ...boxes.top, left: boxes.w / 4 - boxes.top.size / 2 };
  // Nullable on this public route (no ActiveAssistantGate); the proof beat's
  // model calls fall back to local generation when it's absent.
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  // The chosen character, packaged so the starter modal can reopen on Back.
  const resume: StarterResume | null = selected
    ? {
        bodyShape: selected.bodyShape,
        eyeStyle: selected.eyeStyle,
        color: selected.color,
        name,
      }
    : null;

  // Beat 1 → Beat 3: a starter was built + named right in the card. Seed a
  // settled greeting so the conversation panel is never empty, then compose.
  function chooseStarter(char: CastCharacter, chosenName: string) {
    setSelected(char);
    setNames((prev) => ({ ...prev, [char.id]: chosenName }));
    convo.seedGreeting(chosenName);
    setPhase("job");
  }

  // Back from a composing beat reopens the customization card (keeps the pick).
  function reopenCustomize() {
    clearBeatTimers();
    convo.reset();
    setJobs([]);
    setJobEdges({});
    setRathers([]);
    setStyle({});
    setMime(null);
    setRatherSent(false);
    setPhase("starter");
  }

  // Job (multi-select): each newly-added job keeps a stable fly-in edge so its
  // prop arcs in once and then stays clustered around the character. Taps
  // assemble the locked-input draft on the right; Send fires it.
  function toggleJob(key: JobKey) {
    const adding = !jobs.includes(key);
    const next = adding ? [...jobs, key] : jobs.filter((k) => k !== key);
    setJobs(next);
    setJobEdges((prev) =>
      prev[key] ? prev : { ...prev, [key]: EDGES[tapRef.current++ % EDGES.length] },
    );
    void kickoffJobContext(next);
    convo.setDraft(assembleJobMessage(next));
  }

  // Job Send: commit the assembled draft + stream the demo response.
  function sendJobs() {
    if (jobs.length === 0) return;
    convo.commit(jobTurn(jobs[0])); // first pick's script drives the demo response
  }

  // Rather (multi-select): adding one plays its mime (transient) and assembles
  // the locked-input draft. Send fires it.
  function toggleRather(key: RatherKey) {
    const has = rathers.includes(key);
    const next = has ? rathers.filter((k) => k !== key) : [...rathers, key];
    setRathers(next);
    void kickoffRatherContext(next);
    convo.setDraft(assembleRatherMessage(next));
    if (has) return;
    const choice = RATHERS.find((r) => r.key === key)!;
    const nonce = (tapRef.current += 1);
    setMime({ rather: choice, edge: EDGES[nonce % EDGES.length], nonce });
    clearTimeout(mimeTimer.current);
    mimeTimer.current = window.setTimeout(() => setMime(null), 1500);
  }

  // Rather Send: commit the draft + arm the post-stream "boring stuff" offer.
  function sendRathers() {
    if (rathers.length === 0) return;
    const choice = RATHERS.find((r) => r.key === rathers[0])!;
    convo.commit(ratherTurn(rathers[0], choice.label));
    setRatherSent(true);
  }

  // Offer "Let's go!" → advance to the This/That rounds.
  function acceptOffer() {
    clearBeatTimers();
    setMime(null);
    setPhase("style");
  }

  // This/That: persist each round's pick; the final round → Proof.
  function onStyleRound(next: StyleProfile) {
    setStyle(next);
  }
  function onStyleDone(next: StyleProfile) {
    setStyle(next);
    console.log("[Cast] complete", { character: selected?.id, name, jobs, rathers, style: next });
    setPhase("done");
  }

  return (
    // Cast is dark-only — semantic tokens resolve to their dark values within
    // this subtree, giving the "cave" palette regardless of the app theme.
    <div className="cast-stage" data-theme="dark">
      <div className="cast-panel" ref={panelRef}>
        {/* Beat 1 — starter line-up + in-card customization & naming */}
        {phase === "starter" && <CastStarter resume={resume} onChoose={chooseStarter} />}

        {/* Beat 3 — what will I be doing for you? (two-panel: options | chat) */}
        {phase === "job" && selected && (
          <CastTwoPanel
            left={
              <CastJob
                character={selected}
                heroBox={leftPanelBox}
                jobs={jobs}
                jobEdges={jobEdges}
                onToggle={toggleJob}
                onContinue={() => setPhase("rather")}
                onBack={reopenCustomize}
              />
            }
            right={
              <CastConversationView
                messages={convo.messages}
                assistantName={name}
                input={{ value: convo.draft, canSend: jobs.length > 0, onSend: sendJobs }}
              />
            }
          />
        )}

        {/* Beat 4 — rather (two-panel: options | chat) */}
        {phase === "rather" && selected && (
          <CastTwoPanel
            left={
              <CastRather
                character={selected}
                heroBox={leftPanelBox}
                jobs={jobs}
                rathers={rathers}
                mime={mime}
                onToggle={toggleRather}
                onBack={() => {
                  clearBeatTimers();
                  setMime(null);
                  setPhase("job");
                }}
              />
            }
            right={
              <CastConversationView
                messages={convo.messages}
                assistantName={name}
                input={{ value: convo.draft, canSend: rathers.length > 0, onSend: sendRathers }}
                offer={ratherSent && !convo.streaming ? { onAccept: acceptOffer } : undefined}
              />
            }
          />
        )}

        {/* Beat 5 — this or that (two-panel: options | chat) */}
        {phase === "style" && selected && (
          <CastTwoPanel
            left={
              <CastStyle
                character={selected}
                name={name}
                heroBox={leftPanelBox}
                jobs={jobs}
                ascended={rathers.length === RATHERS.length}
                onChoose={(value) => convo.send(styleTurn(value))}
                onRoundPicked={onStyleRound}
                onDone={onStyleDone}
                onBack={() => setPhase("rather")}
              />
            }
            right={<CastConversationView messages={convo.messages} assistantName={name} />}
          />
        )}

        {/* Beat 6 — proof (two-panel). Hero sits a little lower so juggling props
            have headroom above without clipping. */}
        {phase === "done" && selected && (
          <CastTwoPanel
            left={
              <CastProof
                character={selected}
                box={{ ...leftPanelBox, top: leftPanelBox.top + Math.round(leftPanelBox.size * 0.7) }}
                jobs={jobs}
                rathers={rathers}
                style={style}
                ascended={rathers.length === RATHERS.length}
                assistantId={assistantId}
                onAction={(which) => {
                  console.log("[Cast] proof action", {
                    which,
                    character: selected.id,
                    name,
                    jobs,
                    rathers,
                    style,
                  });
                }}
                onEndpoint={(which) => setPhase(which)}
                onBack={() => setPhase("style")}
              />
            }
            right={<CastConversationView messages={convo.messages} assistantName={name} />}
          />
        )}

        {/* Endpoints — drop into the (mocked) real product chat. */}
        {(phase === "chat" || phase === "boost") && selected && (
          <CastChat
            name={name}
            picks={{ jobs, rathers, style }}
            mode={phase}
            onBack={() => setPhase("done")}
          />
        )}
      </div>
    </div>
  );
}
