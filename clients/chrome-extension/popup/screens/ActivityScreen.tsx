import { useEffect, useMemo, useState } from 'react';

import type { OperationEntry } from '../../background/event-log.js';
import { sendMessage } from '../lib/chrome-message.js';
import { formatDuration, formatTime } from '../lib/format.js';

export interface ActivityScreenProps {
  onBack: () => void;
  onSelectOperation: (op: OperationEntry) => void;
}

export function ActivityScreen({
  onBack,
  onSelectOperation,
}: ActivityScreenProps) {
  const [operations, setOperations] = useState<OperationEntry[]>([]);

  useEffect(() => {
    sendMessage<{ ok: boolean; operations: OperationEntry[] }>({
      type: 'get-operations',
    }).then((response) => {
      if (response?.ok) {
        setOperations(response.operations);
      }
    });
  }, []);

  const sorted = useMemo(() => [...operations].reverse(), [operations]);

  return (
    <div>
      <header className="flex items-center gap-2 mb-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-alt transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M9 2L4 7L9 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className="text-[13px] font-semibold text-fg-muted tracking-[0.01em]">
          Activity
        </h1>
      </header>

      {sorted.length === 0 ? (
        <p className="text-center py-8 px-4 text-fg-subtle text-xs">
          No operations yet.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {sorted.map((op) => {
            const hasCallbackFailure = op.callbackStatus !== undefined;
            const iconClass = hasCallbackFailure
              ? 'bg-danger-soft text-danger'
              : op.respondedAt
                ? op.isError ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'
                : 'bg-warning-soft text-warning';
            const iconSymbol = hasCallbackFailure
              ? '!'
              : op.respondedAt
                ? op.isError ? '✗' : '✓'
                : '⋯';

            const durationText = op.durationMs != null
              ? ` · ${formatDuration(op.durationMs)}`
              : '';

            const callbackText = hasCallbackFailure
              ? ` · POST ${op.callbackStatus === 0 ? 'dropped' : op.callbackStatus}`
              : '';

            return (
              <button
                key={op.id}
                type="button"
                onClick={() => onSelectOperation(op)}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-surface transition-colors cursor-pointer text-left border border-edge hover:border-edge-hover bg-surface"
              >
                <div
                  className={`w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0 text-xs ${iconClass}`}
                >
                  {iconSymbol}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg truncate">
                    {op.operationName}
                  </p>
                  <p className="text-[10px] text-fg-subtle mt-0.5">
                    {formatTime(op.requestedAt)}
                    {durationText}
                    {op.isError ? ' · Error' : ''}
                    {callbackText}
                  </p>
                </div>
                <svg
                  className="text-fg-subtle shrink-0"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <path
                    d="M4 2L8 6L4 10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
