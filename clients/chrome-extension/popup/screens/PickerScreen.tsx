import type { CloudAssistant } from '../../background/cloud-api.js';

export interface PickerScreenProps {
  assistants: CloudAssistant[];
  email?: string;
  error?: string;
  refreshing?: boolean;
  onSelect: (id: string, name: string) => void;
  onBack: () => void;
  onRetry?: () => void;
  onCreateAssistant: () => void;
}

export function PickerScreen({
  assistants,
  onSelect,
  onBack,
  error,
  refreshing,
  onRetry,
  onCreateAssistant,
}: PickerScreenProps) {
  const isEmpty = assistants.length === 0 && !error;

  return (
    <div>
      <header className="flex items-center gap-2 mb-1">
        <button
          type="button"
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-alt transition-colors border-none bg-transparent text-fg cursor-pointer"
          aria-label="Back"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
          >
            <path
              d="M9 2L4 7L9 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className="text-lg font-semibold text-fg">Choose an Assistant</h1>
      </header>

      {!isEmpty && !error && (
        <p className="text-sm text-fg-muted mb-4">
          Select which assistant to connect to this browser.
        </p>
      )}

      {error && (
        <div className="rounded-lg bg-danger-soft p-3 mb-4" role="alert">
          <p className="text-sm text-danger font-medium mb-1">
            Unable to load assistants
          </p>
          <p className="text-xs text-fg-muted break-words">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={refreshing}
              className="mt-2 text-xs px-3 py-1.5 rounded bg-surface-alt text-fg border-none cursor-pointer hover:bg-edge-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {refreshing ? 'Refreshing...' : 'Retry'}
            </button>
          )}
        </div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center text-center px-2 pt-5 pb-2">
          <p className="text-sm font-medium text-fg mb-1.5">
            You don't have an assistant yet
          </p>
          <p className="text-xs text-fg-muted mb-4">
            Create one in the Vellum app, then come back here to connect it.
          </p>
          <button
            type="button"
            onClick={onCreateAssistant}
            className="bg-fg text-bg rounded-lg px-4 py-2.5 text-sm font-medium w-full max-w-[240px] hover:opacity-90 transition-opacity cursor-pointer"
          >
            Create an assistant
          </button>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={refreshing}
              className="mt-2 bg-transparent text-fg-muted border border-edge rounded-lg px-4 py-2.5 text-sm w-full max-w-[240px] hover:border-edge-hover hover:text-fg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          )}
        </div>
      )}

      {assistants.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {assistants.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id, a.name)}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-surface transition-colors cursor-pointer border-none bg-transparent text-left w-full"
            >
              <div className="w-12 h-12 rounded-lg bg-surface-alt flex items-center justify-center shrink-0 text-fg-muted">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <path
                    d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="text-sm font-medium text-fg flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {a.name}
              </span>
              <svg
                className="text-fg-subtle shrink-0"
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
              >
                <path
                  d="M5 2L10 7L5 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
