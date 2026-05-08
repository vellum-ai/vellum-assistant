import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";

interface CommandBarProps {
  readonly disabled: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onToggleListening: () => void;
}

export function CommandBar({
  disabled,
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
      className="flex items-center gap-3 border-t border-hud-panelBorder/60 px-4 py-2 bg-hud-panel/50"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleListening}
        className="font-display text-[10px] tracking-[0.32em] uppercase text-hud-glow hover:text-white disabled:opacity-40 transition-colors"
      >
        ⏵ talk
      </button>
      <span className="text-hud-muted">›</span>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="speak or type · /tasks · /slack · /quit"
        className="flex-1 bg-transparent text-[13px] text-hud-accent placeholder:text-hud-muted/60 outline-none font-mono disabled:opacity-40"
        spellCheck={false}
        autoFocus
      />
      <button
        type="submit"
        disabled={disabled}
        className="font-display text-[10px] tracking-[0.32em] uppercase text-hud-accent hover:text-white disabled:opacity-40 transition-colors"
      >
        send
      </button>
    </form>
  );
}
