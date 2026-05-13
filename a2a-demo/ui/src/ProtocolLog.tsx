import { useEffect, useRef } from 'preact/hooks';
import type { LogEntry } from './types.js';

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

export function ProtocolLog({ entries }: { entries: LogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div class="protocol-log" ref={containerRef}>
      {entries.length === 0 && (
        <div class="log-empty">No events yet. Start the coffee run to see protocol traffic.</div>
      )}
      {entries.map((entry, i) => {
        const arrow = entry.direction === 'out' ? '-->' : '<--';
        return (
          <div class="log-entry" key={i}>
            <span class="log-line">
              [{formatTimestamp(entry.timestamp)}] {arrow} {entry.peer}: {entry.message}
            </span>
            {entry.raw && (
              <details class="log-raw">
                <summary>Raw event</summary>
                <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
