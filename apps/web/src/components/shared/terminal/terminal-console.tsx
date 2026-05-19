
import React, { useEffect, useRef } from "react";
import "xterm/css/xterm.css";

// xterm and xterm-addon-fit are loaded dynamically to avoid SSR issues.
// We rely on dynamic import so that the xterm DOM APIs are only accessed
// inside a useEffect (client-side).

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface TerminalConsoleProps {
  /** Called when the user types into the terminal. */
  onData?: (data: string) => void;
  /** Called when the terminal container is resized and a new column/row size is determined. */
  onResize?: (dimensions: TerminalDimensions) => void;
  /** Optional CSS class for the outer container element. */
  className?: string;
  /** Whether the terminal is in a read-only state (user input disabled). */
  readOnly?: boolean;
  /**
   * Optional ref that will be populated with a `write(data: string)` function
   * once the terminal is initialised, and set back to `null` on cleanup.
   * Use this to write PTY output into the terminal from the parent.
   */
  writeRef?: React.MutableRefObject<((data: string) => void) | null>;
}

/**
 * TerminalConsole mounts an xterm.js terminal inside a div and emits
 * callbacks for keystrokes (`onData`) and terminal resize events
 * (`onResize`).  It does not manage the WebSocket or session — that is
 * the responsibility of the parent hook / component.
 */
export function TerminalConsole({ onData, onResize, className, readOnly = false, writeRef }: TerminalConsoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terminalRef = useRef<any>(null);
  // Keep stable refs to callbacks so the effect closure is not re-run on
  // every render while still always calling the latest version.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const readOnlyRef = useRef(readOnly);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // readOnly can change after mount (idle -> connected). Keep xterm stdin
    // in sync without remounting so existing terminal content is preserved.
    terminal.options.disableStdin = readOnly;
    if (!readOnly) {
      terminal.focus();
    }
  }, [readOnly]);

  useEffect(() => {
    if (!containerRef.current) return;

    const el = containerRef.current;
    let disposed = false;

    // Declare mutable refs for all resources so the synchronous cleanup
    // returned below can dispose them even if .then() has not fired yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let terminal: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fitAddon: any = null;
    let resizeObserver: ResizeObserver | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dataDisposable: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resizeDisposable: any = null;

    // Dynamically import xterm so that Next.js does not attempt to render
    // it on the server (xterm references browser-only APIs).
    // biome-ignore lint/complexity/useLiteralKeys: dynamic import needs string key for module resolution
    Promise.all([
      import("xterm"),
      import("xterm-addon-fit"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !el) return;

      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "\"JetBrains Mono\", \"Fira Code\", monospace",
        fontSize: 14,
        theme: {
          background: "#0f1117",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          black: "#1e1e1e",
          brightBlack: "#666666",
          red: "#f44747",
          brightRed: "#f44747",
          green: "#6a9955",
          brightGreen: "#6a9955",
          yellow: "#dcdcaa",
          brightYellow: "#dcdcaa",
          blue: "#569cd6",
          brightBlue: "#569cd6",
          magenta: "#c586c0",
          brightMagenta: "#c586c0",
          cyan: "#4ec9b0",
          brightCyan: "#4ec9b0",
          white: "#d4d4d4",
          brightWhite: "#ffffff",
        },
        disableStdin: readOnly,
        scrollback: 2000,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(el);
      terminalRef.current = terminal;

      // Cmd-K (macOS) clears the terminal. We intentionally do NOT bind
      // Ctrl-K because it is the standard readline shortcut for "kill from
      // cursor to end of line" on Linux/Windows terminals.
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.key === "k" && event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          if (event.type === "keydown") {
            event.preventDefault();
            terminal.clear();
          }
          return false;
        }
        return true;
      });

      // Fit terminal to container immediately and on resize.
      try {
        fitAddon.fit();
        // Emit initial dimensions
        if (terminal.cols && terminal.rows) {
          onResizeRef.current?.({ cols: terminal.cols, rows: terminal.rows });
        }
      } catch {
        // fit() can throw if the container has no layout yet — safe to ignore.
      }

      // Subscribe to user input
      dataDisposable = terminal.onData((data: string) => {
        if (!readOnlyRef.current) {
          onDataRef.current?.(data);
        }
      });

      // Subscribe to terminal resize events (triggered by fitAddon after
      // the ResizeObserver fires and fit() is called).
      resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        onResizeRef.current?.({ cols, rows });
      });

      // ResizeObserver keeps the terminal sized to its container.
      resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch {
          // Ignore layout not ready errors.
        }
      });
      resizeObserver.observe(el);

      // Expose terminal instance on the DOM node for testing purposes.
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).__xtermTerminal = terminal;

      // Populate the writeRef so callers can push PTY output into the terminal.
      if (writeRef) {
        writeRef.current = (data: string) => terminal.write(data);
      }
    });

    // Synchronous cleanup returned directly from useEffect so React calls it
    // on unmount regardless of whether the async .then() has fired yet.
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      resizeDisposable?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      // biome-ignore lint/suspicious/noExplicitAny: cleanup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (el as any).__xtermTerminal;
      if (writeRef) {
        writeRef.current = null;
      }
    };
    // readOnly is handled by the dedicated effect above to avoid remounting.
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
      // Aria role so assistive technologies know this is a terminal region.
      role="region"
      aria-label="Terminal console"
    />
  );
}
