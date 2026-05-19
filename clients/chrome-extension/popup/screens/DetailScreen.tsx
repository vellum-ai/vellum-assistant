import { useState } from 'react';

import type { OperationEntry } from '../../background/event-log.js';
import { formatDuration, formatTime } from '../lib/format.js';

export interface DetailScreenProps {
  operation: OperationEntry;
  onBack: () => void;
}

function formatResponseContent(operation: OperationEntry): string {
  if (operation.responseContent) {
    try {
      return JSON.stringify(JSON.parse(operation.responseContent), null, 2);
    } catch {
      return operation.responseContent;
    }
  }
  if (operation.respondedAt) return 'Empty response';
  return 'Awaiting response…';
}

export function DetailScreen({ operation, onBack }: DetailScreenProps) {
  const hasCallbackFailure = operation.callbackStatus !== undefined;
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'callback'>(
    hasCallbackFailure ? 'callback' : 'request',
  );

  const metaParts: string[] = [formatTime(operation.requestedAt)];
  if (operation.durationMs != null) {
    metaParts.push(formatDuration(operation.durationMs));
  }
  if (operation.isError) {
    metaParts.push('Error');
  }
  if (hasCallbackFailure) {
    metaParts.push(
      `POST ${operation.callbackStatus === 0 ? 'dropped' : operation.callbackStatus}`,
    );
  }

  const tabBase = 'flex-1 py-2 px-3 text-xs text-center border-b-2';
  const tabActive = `${tabBase} text-fg border-fg font-medium`;
  const tabInactive = `${tabBase} text-fg-muted border-transparent hover:text-fg transition-colors`;
  const panelClass = 'bg-surface rounded-lg p-3 text-xs text-fg-muted overflow-auto max-h-64 whitespace-pre-wrap break-words font-mono';

  return (
    <div>
      <header className="flex items-center gap-2 mb-3.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center w-7 h-7 rounded-md text-fg-muted hover:text-fg transition-colors"
          aria-label="Back"
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
        <h1 className="text-[13px] font-semibold text-fg-muted tracking-wide">
          Operation Detail
        </h1>
      </header>

      <div className="mb-3.5">
        <p className="text-base font-semibold text-fg break-words">
          {operation.operationName}
        </p>
        <p className="text-[11px] text-fg-subtle mt-1">
          {metaParts.join(' · ')}
        </p>
      </div>

      <div className="flex border-b border-edge mb-2.5">
        <button
          type="button"
          onClick={() => setActiveTab('request')}
          className={activeTab === 'request' ? tabActive : tabInactive}
        >
          Request
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('response')}
          className={activeTab === 'response' ? tabActive : tabInactive}
        >
          Response
        </button>
        {hasCallbackFailure && (
          <button
            type="button"
            onClick={() => setActiveTab('callback')}
            className={activeTab === 'callback' ? tabActive : tabInactive}
          >
            Callback
          </button>
        )}
      </div>

      {activeTab === 'request' && (
        <pre className={panelClass}>
          {operation.request
            ? JSON.stringify(operation.request, null, 2)
            : 'No request data available'}
        </pre>
      )}

      {activeTab === 'response' && (
        <pre className={panelClass}>
          {formatResponseContent(operation)}
        </pre>
      )}

      {activeTab === 'callback' && (
        <pre className={panelClass}>
          {formatCallbackFailure(operation)}
        </pre>
      )}
    </div>
  );
}

function formatCallbackFailure(operation: OperationEntry): string {
  if (operation.callbackStatus === undefined) {
    return 'Callback POST has not failed.';
  }
  const lines: string[] = [];
  if (operation.callbackStatus === 0) {
    lines.push('Status: dropped (POST never reached the wire)');
  } else {
    lines.push(`Status: HTTP ${operation.callbackStatus}`);
  }
  if (operation.callbackError) {
    lines.push('');
    lines.push(operation.callbackError);
  }
  return lines.join('\n');
}
