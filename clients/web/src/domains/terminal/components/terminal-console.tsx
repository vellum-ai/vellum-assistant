import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { Terminal as TerminalType, IDisposable } from "xterm";
import "xterm/css/xterm.css";

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface TerminalConsoleProps {
  onData?: (data: string) => void;
  onResize?: (dimensions: TerminalDimensions) => void;
  className?: string;
  readOnly?: boolean;
  writeRef?: MutableRefObject<((data: string) => void) | null>;
}

export function TerminalConsole({
  onData,
  onResize,
  className,
  readOnly = false,
  writeRef,
}: TerminalConsoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalType | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const readOnlyRef = useRef(readOnly);
  useLayoutEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    readOnlyRef.current = readOnly;
  });

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    terminal.options.disableStdin = readOnly;
    if (!readOnly) {
      terminal.focus();
    }
  }, [readOnly]);

  useEffect(() => {
    if (!containerRef.current) return;

    const el = containerRef.current;
    let disposed = false;

    let terminal: TerminalType | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: IDisposable | null = null;
    let resizeDisposable: IDisposable | null = null;

    Promise.all([import("xterm"), import("xterm-addon-fit")]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (disposed || !el) return;

        const term = new Terminal({
          cursorBlink: true,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
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
        terminal = term;

        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        terminalRef.current = term;

        term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          if (
            event.key === "k" &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            if (event.type === "keydown") {
              event.preventDefault();
              term.clear();
            }
            return false;
          }
          return true;
        });

        try {
          fit.fit();
          if (term.cols && term.rows) {
            onResizeRef.current?.({
              cols: term.cols,
              rows: term.rows,
            });
          }
        } catch {
          // fit() can throw if the container has no layout yet
        }

        dataDisposable = term.onData((data: string) => {
          if (!readOnlyRef.current) {
            onDataRef.current?.(data);
          }
        });

        resizeDisposable = term.onResize(
          ({ cols, rows }: { cols: number; rows: number }) => {
            onResizeRef.current?.({ cols, rows });
          },
        );

        resizeObserver = new ResizeObserver(() => {
          try {
            fit.fit();
          } catch {
            // Ignore layout not ready errors
          }
        });
        resizeObserver.observe(el);

        if (writeRef) {
          writeRef.current = (data: string) => term.write(data);
        }
      },
    );

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      resizeDisposable?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      if (writeRef) {
        writeRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
      role="region"
      aria-label="Terminal console"
    />
  );
}
