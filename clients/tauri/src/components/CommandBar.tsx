import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";

interface CommandBarProps {
  readonly disabled: boolean;
  readonly listening: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onToggleListening: () => void;
}

/**
 * HUD console strip — replaces the chat-style input bar. Visually framed
 * like a command-line interface with a leading prompt glyph, a "talk"
 * mic-toggle, and an inline status pip that reflects current listen
 * state. The bar lives inside the bottom rail of the main HUD.
 */
export function CommandBar({
  disabled,
  listening,
  onSubmit,
  onToggleListening,
}: CommandBarProps): JSX.Element {
  const [value, setValue] = useState("");

  const flush = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue("");
  }, [onSubmit, value]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      flush();
    },
    [flush],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        flush();
      }
    },
    [flush],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-3 border-t border-hud-panelBorder/60 bg-black/55 px-4 py-2.5 backdrop-blur"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleListening}
        className={`font-display flex items-center gap-2 border px-3 py-1 text-[10px] uppercase tracking-[0.32em] transition-colors disabled:opacity-40 ${
          listening
            ? "border-hud-ok/70 text-hud-ok shadow-[0_0_14px_rgba(72,255,177,0.35)]"
            : "border-hud-panelBorder/60 text-hud-glow hover:border-hud-accent/80 hover:text-white"
        }`}
        aria-pressed={listening}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            listening ? "animate-pulse bg-hud-ok" : "bg-hud-mute"
          }`}
        />
        {listening ? "live" : "talk"}
      </button>
      <span className="font-display text-[10px] tracking-[0.4em] text-hud-accent/70">
        eli ›
      </span>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="transmit a command · /quit"
        className="flex-1 bg-transparent font-mono text-[13px] text-hud-accent caret-hud-accent outline-none placeholder:text-hud-muted/55 disabled:opacity-40"
        spellCheck={false}
        autoFocus
      />
      <span className="font-display text-[9px] tracking-[0.36em] text-hud-mute">
        ⌃↵ send
      </span>
      <button
        type="submit"
        disabled={disabled}
        className="font-display border border-hud-panelBorder/60 px-3 py-1 text-[10px] uppercase tracking-[0.32em] text-hud-accent transition-colors hover:border-hud-accent/80 hover:text-white disabled:opacity-40"
      >
        send
      </button>
    </form>
  );
}
