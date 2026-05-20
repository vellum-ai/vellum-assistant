import { type MutableRefObject, useEffect, useRef } from "react";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terminalRef = useRef<any>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const readOnlyRef = useRef(readOnly);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  readOnlyRef.current = readOnly;

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let terminal: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fitAddon: any = null;
    let resizeObserver: ResizeObserver | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dataDisposable: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resizeDisposable: any = null;

    Promise.all([import("xterm"), import("xterm-addon-fit")]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (disposed || !el) return;

        terminal = new Terminal({
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

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(el);
        terminalRef.current = terminal;

        terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          if (
            event.key === "k" &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            if (event.type === "keydown") {
              event.preventDefault();
              terminal.clear();
            }
            return false;
          }
          return true;
        });

        try {
          fitAddon.fit();
          if (terminal.cols && terminal.rows) {
            onResizeRef.current?.({
              cols: terminal.cols,
              rows: terminal.rows,
            });
          }
        } catch {
          // fit() can throw if the container has no layout yet
        }

        dataDisposable = terminal.onData((data: string) => {
          if (!readOnlyRef.current) {
            onDataRef.current?.(data);
          }
        });

        resizeDisposable = terminal.onResize(
          ({ cols, rows }: { cols: number; rows: number }) => {
            onResizeRef.current?.({ cols, rows });
          },
        );

        resizeObserver = new ResizeObserver(() => {
          try {
            fitAddon.fit();
          } catch {
            // Ignore layout not ready errors
          }
        });
        resizeObserver.observe(el);

        if (writeRef) {
          writeRef.current = (data: string) => terminal.write(data);
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
