import { useState } from "react";

/** The portable prompt the user copies into their prior assistant. */
export const BOOST_PROMPT =
  "Summarize what you've learned about me as a user. Write it as a brief profile — how I work, what I care about, and how I prefer to be helped. Keep it to a short paragraph.";

/**
 * Boost endpoint: a copy block with the portable prompt and a dedicated paste
 * box (separate from the locked chat input). Submitting drops the user into the
 * mocked chat with the pasted text as their last message.
 */
export function CastBoostBlock({ onSubmit }: { onSubmit: (pasted: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(BOOST_PROMPT);
    } catch {
      // clipboard may be unavailable; the prompt is still visible to copy manually
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="cast-boost">
      <p className="cast-boost__lead">
        Copy this, paste it into your prior assistant, then paste its response back here.
      </p>
      <div className="cast-boost__prompt">
        <p className="cast-boost__prompt-text">{BOOST_PROMPT}</p>
        <button className="cast-boost__copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <textarea
        className="cast-boost__paste"
        placeholder="Paste your prior assistant's response here…"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        rows={5}
      />
      <button className="cast-boost__submit" onClick={() => onSubmit(pasted)}>
        Bring it over
      </button>
    </div>
  );
}
