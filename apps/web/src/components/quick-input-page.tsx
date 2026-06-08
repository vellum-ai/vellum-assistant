import { ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { dismissQuickInput, submitQuickInput } from "@/runtime/quick-input";
import { publicAsset } from "@/utils/public-asset";

/**
 * Lightweight input page rendered inside the Electron quick input
 * BrowserWindow — a frameless, always-on-top panel the user invokes
 * via Cmd+Shift+/ to send a message without switching to the main
 * window. Enter submits; Escape dismisses.
 *
 * Standalone (no auth, no RootLayout) so the panel loads instantly.
 * Off-Electron the page is inert — the runtime wrapper no-ops.
 */
export function QuickInputPage() {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }
      void submitQuickInput(trimmed);
      setInput("");
    },
    [input],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void dismissQuickInput();
      }
    },
    [],
  );

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-2">
      <form
        onSubmit={handleSubmit}
        className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-base)] px-4 py-3 shadow-lg"
      >
        <img
          src={publicAsset("/vellum-logo.svg")}
          alt="Vellum"
          width={24}
          height={24}
          className="shrink-0 dark:hidden"
          draggable={false}
        />
        <img
          src={publicAsset("/vellum-logo-white.svg")}
          alt="Vellum"
          width={24}
          height={24}
          className="hidden shrink-0 dark:block"
          draggable={false}
        />
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Vellum anything..."
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-accent)] text-[var(--content-on-accent)] transition-opacity disabled:opacity-30"
        >
          <ArrowUp size={16} />
        </button>
      </form>
    </div>
  );
}
