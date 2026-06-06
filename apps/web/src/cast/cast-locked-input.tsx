import { useEffect, useRef } from "react";

/**
 * The visible-but-locked chat input for the two-panel beats. The user never
 * types here — phrases accumulate from left-panel taps. It's a <div>, not an
 * <input>, so there's no caret and it can't take keyboard focus; the only live
 * control is Send. The assembled text scrolls internally (tail pinned) so a long
 * message never blows out the panel.
 */
export function CastLockedInput({
  value,
  canSend,
  onSend,
}: {
  value: string;
  canSend: boolean;
  onSend: () => void;
}) {
  const valueRef = useRef<HTMLDivElement>(null);

  // Keep the latest appended phrase visible as the message grows.
  useEffect(() => {
    const el = valueRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [value]);

  return (
    <div className="cast-locked-input">
      <div className="cast-locked-input__value" ref={valueRef} aria-hidden={value.length === 0}>
        {value || <span className="cast-locked-input__ph">your picks assemble here…</span>}
      </div>
      <button
        type="button"
        className="cast-locked-input__send"
        disabled={!canSend}
        onClick={onSend}
        aria-label="Send"
      >
        Send
      </button>
    </div>
  );
}
