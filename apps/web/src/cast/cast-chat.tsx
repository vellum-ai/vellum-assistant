import { useState } from "react";

import { CastBoostBlock } from "@/cast/cast-boost";
import { CastConversationView, useCastConversation } from "@/cast/cast-conversation";
import { endpointTurn, type CastPicks } from "@/cast/cast-templates";

/**
 * Mocked post-endpoint product chat (both Loop-1 endpoints land here). Renders
 * through the real chat component; the assistant's first reply IS the inference
 * moment — synthesized from the Cast picks ("not recital"), Sonnet-shaped. Fully
 * mocked, faithful to what the real chat would render.
 *
 * - "chat": a single suggested-prompt chip floats above the input; tap-to-send.
 * - "boost": a copy-block + paste box first; submitting drops into the chat with
 *   the paste as the last user message.
 */
export function CastChat({
  name,
  picks,
  mode,
  onBack,
}: {
  name: string;
  picks: CastPicks;
  mode: "chat" | "boost";
  onBack: () => void;
}) {
  const convo = useCastConversation();
  const [chipUsed, setChipUsed] = useState(false);
  const [boostDone, setBoostDone] = useState(false);

  const showBoost = mode === "boost" && !boostDone;

  function sendChip() {
    convo.send(endpointTurn("so what do you remember about me already?", picks));
    setChipUsed(true);
  }

  function submitBoost(pasted: string) {
    // Fallback: garbage/empty paste is treated as plain user text — never gate.
    const text = pasted.trim() || "Here's what my last assistant knows about me.";
    convo.send(endpointTurn(text, picks));
    setBoostDone(true);
  }

  return (
    <div className="cast-chat">
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      {showBoost ? (
        <div className="cast-chat__boost-wrap">
          <CastBoostBlock onSubmit={submitBoost} />
        </div>
      ) : (
        <div className="cast-chat__panel">
          <CastConversationView messages={convo.messages} assistantName={name} emptyHint="" />

          {mode === "chat" && !chipUsed && (
            <div className="cast-chat__chip-row">
              <button className="cast-chat__chip" onClick={sendChip}>
                so what do you remember about me already?
              </button>
            </div>
          )}

          {/* Faithful (non-functional) product chat input shell. */}
          <div className="cast-chat__input" aria-hidden>
            <span className="cast-chat__input-ph">Message {name}…</span>
          </div>
        </div>
      )}
    </div>
  );
}
